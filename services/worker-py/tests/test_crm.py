"""CRM sync: every source event against a fake Twenty (mock transport), idempotency, dry run, and
the workflows on a real Temporal. Users, organizations and subscriptions come from the compose
Postgres, as in production. The HTTP shapes were checked against Twenty v2.56.1 (docs/crm.md)."""

import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

import asyncpg
import httpx2
import pytest
from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.worker import Worker

from tests.conftest import new_org
from tests.test_billing import PLANS, event, subscribe
from worker import settings
from worker.billing import BillingActivities
from worker.crm import Booking, CrmActivities, CrmEvent, Twenty, load_config
from worker.support import Chatwoot
from worker.workflows import BillingEventWorkflow, CrmSyncWorkflow

CONFIG = load_config(settings.CRM_FILE)
UNIQUE = {"people": "appUserId", "companies": "appOrgId", "opportunities": "appOrgId"}
FILTER = re.compile(r'^([\w.]+)\[eq\]:"([^"]*)"$')
SINGULAR = {
    "people": "Person",
    "companies": "Company",
    "opportunities": "Opportunity",
    "notes": "Note",
    "noteTargets": "NoteTarget",
}


def field(row: dict[str, Any], path: str) -> Any:
    for part in path.split("."):
        row = row.get(part) or {}
    return row or None


class FakeTwenty:
    """Twenty's REST shapes (`{"data": {"people": [...]}}`, `createPerson`, 400 on a duplicate of
    a unique field) over an in-memory store. Also answers Chatwoot's conversation endpoint."""

    def __init__(self, sender: dict[str, Any] | None = None, verified: bool = True) -> None:
        self.rows: dict[str, list[dict[str, Any]]] = {k: [] for k in SINGULAR}
        self.writes: list[tuple[str, str, Any]] = []
        self.sender, self.verified = sender or {}, verified

    def handle(self, req: httpx2.Request) -> httpx2.Response:
        path = req.url.path
        if path.startswith("/api/v1/accounts/"):  # Chatwoot
            meta = {"sender": self.sender, "hmac_verified": self.verified}
            return httpx2.Response(200, json={"id": 42, "meta": meta})
        assert req.headers["authorization"] == "Bearer key"
        parts = path.removeprefix("/rest/").split("/")
        plural, rows = parts[0], self.rows[parts[0]]
        body: Any = json.loads(req.content) if req.content else None
        if req.method == "GET" and len(parts) == 2:
            row = next(r for r in rows if r["id"] == parts[1])
            return httpx2.Response(200, json={"data": {SINGULAR[plural].lower(): row}})
        if req.method == "GET":
            match = FILTER.match(req.url.params.get("filter", ""))
            assert match, req.url
            found = [r for r in rows if field(r, match[1]) == match[2]]
            return httpx2.Response(200, json={"data": {plural: found}})
        self.writes.append((req.method, plural, body))
        if req.method == "POST":
            for key in (UNIQUE.get(plural), "appEventId", "emails.primaryEmail"):
                if (
                    key
                    and field(body, key)
                    and any(field(r, key) == field(body, key) for r in rows)
                ):
                    return httpx2.Response(
                        400, json={"messages": ["A duplicate entry was detected"]}
                    )
            row = {"id": str(uuid.uuid4()), "companyId": None, **body}
            rows.append(row)
            return httpx2.Response(201, json={"data": {f"create{SINGULAR[plural]}": row}})
        row = next(r for r in rows if r["id"] == parts[1])
        row.update(body)
        return httpx2.Response(200, json={"data": {f"update{SINGULAR[plural]}": row}})

    def activities(self, pool: asyncpg.Pool, *, chatwoot: bool = False) -> CrmActivities:
        http = httpx2.AsyncClient(transport=httpx2.MockTransport(self.handle))
        return CrmActivities(
            pool=pool,
            crm=Twenty("http://twenty.test", "key", http),
            config=CONFIG,
            plans=PLANS,
            chatwoot=Chatwoot("http://cw.test", "t", "https://cw.example", http)
            if chatwoot
            else None,
            calcom_url="https://app.cal.com",
        )

    def count(self, method: str, plural: str) -> int:
        return sum(1 for m, p, _ in self.writes if (m, p) == (method, plural))


async def new_user(pool: asyncpg.Pool, org_id: str | None = None, email: str = "") -> str:
    user_id = str(uuid.uuid4())
    await pool.execute(
        'insert into "user" (id, name, email) values ($1, $2, $3)',
        user_id,
        "Ada Lovelace",
        email or f"{user_id}@example.com",
    )
    if org_id:
        await pool.execute(
            "insert into member (id, organization_id, user_id, role, created_at)"
            " values ($1, $2, $3, 'owner', now())",
            str(uuid.uuid4()),
            org_id,
            user_id,
        )
    return user_id


async def test_dry_run_without_credentials(pool: asyncpg.Pool) -> None:
    acts = CrmActivities(
        pool=pool, crm=None, config=CONFIG, plans=PLANS, chatwoot=None, calcom_url=""
    )
    assert await acts.sync(CrmEvent(kind="user.created", eventId="user:x", userId="x")) == "dry-run"


async def test_signup_and_org_create_person_and_company_once(pool: asyncpg.Pool) -> None:
    fake = FakeTwenty()
    acts = fake.activities(pool)
    org_id = await new_org(pool)
    user_id = await new_user(pool, org_id)
    for _ in range(2):  # a retried activity or a second start changes nothing
        assert (
            await acts.sync(CrmEvent("user.created", f"user:{user_id}", userId=user_id)) == "person"
        )
        e = CrmEvent("org.created", f"org:{org_id}", userId=user_id, orgId=org_id)
        assert await acts.sync(e) == "company"
    [person], [company] = fake.rows["people"], fake.rows["companies"]
    assert person["appUserId"] == user_id
    assert person["name"] == {"firstName": "Ada", "lastName": "Lovelace"}
    assert (company["appOrgId"], company["name"]) == (org_id, org_id)
    assert person["companyId"] == company["id"]
    assert fake.count("POST", "people") == fake.count("POST", "companies") == 1


async def test_lead_from_a_booking_becomes_the_signed_up_user(pool: asyncpg.Pool) -> None:
    fake = FakeTwenty()
    acts = fake.activities(pool)
    email = f"{uuid.uuid4()}@example.com"
    b = Booking("BOOKING_CREATED", "uid1", "Demo", "2026-11-10T10:00:00Z", email, "Grace Hopper")
    await acts.sync(CrmEvent("booking", "cal:BOOKING_CREATED:uid1:t", booking=b))
    user_id = await new_user(pool, email=email)
    await acts.sync(CrmEvent("user.created", f"user:{user_id}", userId=user_id))
    [person] = fake.rows["people"]  # matched by email and stamped with the app user id
    assert (person["appUserId"], person["name"]["firstName"]) == (user_id, "Grace")


async def test_missing_user_is_retried_not_dropped(pool: asyncpg.Pool) -> None:
    acts = FakeTwenty().activities(pool)
    with pytest.raises(Exception, match="not found"):
        await acts.sync(CrmEvent("user.created", "user:none", userId=str(uuid.uuid4())))


async def test_billing_moves_the_deal_by_the_configured_stage(pool: asyncpg.Pool) -> None:
    fake = FakeTwenty()
    acts = fake.activities(pool)
    org_id = await new_org(pool)

    def sync(billing_type: str, n: int) -> Any:
        return acts.sync(
            CrmEvent("billing", f"billing:stripe:{n}", orgId=org_id, billingType=billing_type)
        )

    assert await sync("subscription.activated", 1) == "stage CUSTOMER"
    assert await sync("subscription.activated", 1) == "stage CUSTOMER"  # retry: same deal
    assert await sync("payment.succeeded", 2) == "ignored"  # not in config/crm.json stages
    assert await sync("subscription.canceled", 3) == "stage CHURNED"
    [deal] = fake.rows["opportunities"]
    assert (deal["stage"], deal["appOrgId"], deal["name"]) == ("CHURNED", org_id, "Subscription")
    assert deal["companyId"] == fake.rows["companies"][0]["id"]
    assert fake.count("POST", "opportunities") == 1


async def test_signal_tags_only_qualifying_organizations(pool: asyncpg.Pool) -> None:
    fake = FakeTwenty()
    acts = fake.activities(pool)
    team, solo, paid = await new_org(pool), await new_org(pool), await new_org(pool)
    user_id = await new_user(pool, team)
    for org in (solo, paid):
        await pool.execute(
            "insert into member (id, organization_id, user_id, role, created_at)"
            " values ($1, $2, $3, 'owner', now())",
            str(uuid.uuid4()),
            org,
            user_id,
        )
    await new_user(pool, team)  # team: 2 members, free plan
    await new_user(pool, paid)  # paid: 2 members, on pro
    await subscribe(pool, paid)
    e = CrmEvent("signal", "posthog:ev1", userId=user_id, signal="ACTIVE_TEAM_FREE")
    assert await acts.sync(e) == "tagged 1"
    [company] = fake.rows["companies"]
    assert (company["appOrgId"], company["productSignals"]) == (team, ["ACTIVE_TEAM_FREE"])
    [note] = fake.rows["notes"]
    assert note["title"] == "Signal: Active team on free plan"
    # The next event of the same kind: already tagged, so no new note.
    e2 = CrmEvent("signal", "posthog:ev2", userId=user_id, signal="ACTIVE_TEAM_FREE")
    assert await acts.sync(e2) == "tagged 0"
    assert len(fake.rows["notes"]) == 1
    assert await acts.sync(CrmEvent("signal", "posthog:ev3", userId=user_id, signal="X")) == (
        "ignored"
    )


async def test_support_conversation_note_links_back(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    user_id = await new_user(pool, org_id)
    sender = {"identifier": user_id, "email": "other@example.com", "name": "Ada"}
    fake = FakeTwenty(sender)
    acts = fake.activities(pool, chatwoot=True)
    await acts.sync(CrmEvent("user.created", f"user:{user_id}", userId=user_id))
    e = CrmEvent("support.conversation", "chatwoot:1:42", accountId=1, conversationId=42)
    assert await acts.sync(e) == "note"
    assert await acts.sync(e) == "note"
    [person] = fake.rows["people"]  # verified identifier: our user, not a new contact
    [note] = fake.rows["notes"]
    assert note["appEventId"] == "chatwoot:1:42"
    assert "https://cw.example/app/accounts/1/conversations/42" in note["bodyV2"]["markdown"]
    [target] = fake.rows["noteTargets"]
    assert target == {**target, "noteId": note["id"], "targetPersonId": person["id"]}


async def test_unverified_identifier_is_not_trusted(pool: asyncpg.Pool) -> None:
    user_id = await new_user(pool)
    fake = FakeTwenty({"identifier": user_id, "email": "visitor@example.com"}, verified=False)
    acts = fake.activities(pool, chatwoot=True)
    e = CrmEvent("support.conversation", "chatwoot:1:43", accountId=1, conversationId=43)
    assert await acts.sync(e) == "note"
    [person] = fake.rows["people"]
    assert "appUserId" not in person
    assert person["emails"]["primaryEmail"] == "visitor@example.com"


async def test_booking_notes_once_per_change_and_repair_targets(pool: asyncpg.Pool) -> None:
    fake = FakeTwenty()
    acts = fake.activities(pool)
    email = f"{uuid.uuid4()}@example.com"

    def sync(trigger: str, uid: str, start: str, previous: str = "") -> Any:
        b = Booking(trigger, uid, "Demo", start, email, "Grace", previous)
        return acts.sync(CrmEvent("booking", f"cal:{trigger}:{uid}:{start}", booking=b))

    assert await sync("BOOKING_CREATED", "b1", "2026-11-10T10:00:00Z") == "note"
    assert await sync("BOOKING_CREATED", "b1", "2026-11-10T10:00:00Z") == "note"  # redelivery
    assert await sync("BOOKING_RESCHEDULED", "b2", "2026-11-11T10:00:00Z", "b1") == "note"
    assert await sync("BOOKING_CANCELLED", "b2", "2026-11-11T10:00:00Z") == "note"
    titles = [n["title"] for n in fake.rows["notes"]]
    assert titles == ["Booked: Demo", "Rescheduled: Demo", "Cancelled: Demo"]
    assert "https://app.cal.com/booking/b1" in fake.rows["notes"][1]["bodyV2"]["markdown"]
    assert len(fake.rows["people"]) == 1
    assert len(fake.rows["noteTargets"]) == 3  # one person each, no company yet

    # A crash between the note and its target: the retry links the existing note.
    fake.rows["noteTargets"].clear()
    assert await sync("BOOKING_CREATED", "b1", "2026-11-10T10:00:00Z") == "note"
    assert len(fake.rows["notes"]) == 3
    assert len(fake.rows["noteTargets"]) == 1


async def test_workflows_start_once_and_billing_starts_the_crm_child(pool: asyncpg.Pool) -> None:
    fake = FakeTwenty()
    crm = fake.activities(pool)
    org_id = await new_org(pool)
    queue = f"test-{uuid.uuid4()}"
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    async with Worker(
        client,
        task_queue=queue,
        workflows=[BillingEventWorkflow, CrmSyncWorkflow],
        activities=[BillingActivities(pool, PLANS).apply_billing_event, crm.sync],
    ):
        e = CrmEvent("org.created", f"org:{org_id}", orgId=org_id)
        start = lambda: client.execute_workflow(  # noqa: E731
            CrmSyncWorkflow.run,
            e,
            id=f"crm-{e.eventId}",  # same scheme as apps/api/src/temporal.ts
            task_queue=queue,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
        )
        assert await start() == "company"
        with pytest.raises(WorkflowAlreadyStartedError):
            await start()

        b = event(org_id, "subscription.activated", datetime.now(UTC))
        await client.execute_workflow(
            BillingEventWorkflow.run, b, id=f"billing-stripe-{b.eventId}", task_queue=queue
        )
        child = client.get_workflow_handle(f"crm-billing:stripe:{b.eventId}")
        assert await child.result() == "stage CUSTOMER"
    assert fake.rows["opportunities"][0]["stage"] == "CUSTOMER"
