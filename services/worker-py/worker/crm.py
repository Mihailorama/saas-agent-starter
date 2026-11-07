"""Customer records in an external CRM (docs/crm.md, docs/adr/0026-crm-and-booking.md).

No CRM tables of our own: people, companies, deals and notes live in the CRM (Twenty by default).
The cross-links live there too, in custom fields that `pnpm crm:sync` creates: `appUserId` on
people, `appOrgId` on companies and deals, `appEventId` on notes. Every write is keyed by the id
of the source event (signup, billing event, PostHog event, Chatwoot conversation, booking), and
the unique fields make a retried activity change nothing twice.

Another CRM: implement `Crm` (below) for it and construct it in `__main__.py`; the activity, the
workflow and the API stay as they are.
"""

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, cast

import asyncpg
import httpx2
from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker.billing import Plans
from worker.s3 import S3
from worker.support import Chatwoot, SupportConversation, obj

log = logging.getLogger(__name__)


# Booking payloads in S3_BUCKET, written by apps/api/src/routes/crm.ts (BOOKING_PREFIX there).
BOOKING_PREFIX = "crm-bookings/"


@dataclass(frozen=True)
class Booking:
    """A booking webhook (Cal.diy / Cal.com), reduced to what the note needs: the S3 object the
    API writes (routes/crm.ts). Never a workflow argument: it holds the attendee's email."""

    trigger: str  # BOOKING_CREATED | BOOKING_RESCHEDULED | BOOKING_CANCELLED
    uid: str
    title: str
    startTime: str
    attendeeEmail: str
    attendeeName: str = ""
    rescheduleUid: str = ""  # the earlier booking, on a reschedule


@dataclass(frozen=True)
class CrmEvent:
    """Workflow input, ids only. Contract with apps/api/src/temporal.ts (CrmEvent) and
    BillingEventWorkflow."""

    kind: str  # user.created | org.created | billing | signal | support.conversation | booking
    eventId: str  # source event id: the workflow id and the note's appEventId
    userId: str = ""
    orgId: str = ""
    billingType: str = ""  # subscription.activated ...: informational, the stage comes from our row
    signal: str = ""  # a signal name from config/crm.json
    accountId: int = 0  # Chatwoot
    conversationId: int = 0
    bookingKey: str = ""  # S3 key of the Booking (deleted once the note is written)


@dataclass(frozen=True)
class Signal:
    name: str
    label: str
    plans: frozenset[str]  # empty = any plan
    min_members: int


@dataclass(frozen=True)
class CrmConfig:
    """config/crm.json, the same file `pnpm crm:sync` reads."""

    stages: dict[str, str]  # subscriptions.status -> deal stage value
    deal_name: str
    signals: dict[str, Signal]


def load_config(path: Path) -> CrmConfig:
    doc: dict[str, Any] = json.loads(path.read_text())
    signals = {
        s["name"]: Signal(s["name"], s["label"], frozenset(s.get("plans", [])), s["minMembers"])
        for s in doc["signals"]
    }
    return CrmConfig(dict(doc["stages"]), doc["dealName"], signals)


@dataclass(frozen=True)
class Contact:
    id: str
    company_id: str | None


class Crm(Protocol):
    """What the sync needs from a CRM. Ids are the CRM's own; ours go into its custom fields."""

    name: str

    async def person(self, *, app_user_id: str, email: str, name: str) -> Contact | None:
        """By app user id, else by email (stamping the app user id on it), else a new person.
        None when there is nothing to match or create by."""
        ...

    async def company(self, app_org_id: str, name: str) -> str: ...
    async def join(self, person: Contact, company_id: str) -> None:
        """Puts the person in the company unless they already belong to one."""
        ...

    async def deal(self, app_org_id: str, company_id: str, name: str, stage: str) -> None:
        """Creates the organization's deal or moves it to `stage`."""
        ...

    async def add_signal(self, company_id: str, signal: str) -> bool:
        """Tags the company; False if it already had the tag."""
        ...

    async def note(
        self, event_id: str, title: str, body: str, person: str | None, company: str | None
    ) -> bool:
        """A note on the person and/or company, once per event id; False if it existed."""
        ...


class Duplicate(Exception):
    """A unique field already has this value (a concurrent or earlier write won)."""


def _q(value: str) -> str:
    """A quoted filter value; refuses quotes rather than guessing Twenty's escaping."""
    if '"' in value:
        raise ValueError("filter value contains a quote")
    return f'"{value}"'


class Twenty:
    """Twenty's REST API (`/rest/<objects>`, header `Authorization: Bearer <API key>`)."""

    name = "twenty"

    def __init__(self, url: str, token: str, http: httpx2.AsyncClient) -> None:
        self.base, self.http = f"{url.rstrip('/')}/rest", http
        self.headers = {"authorization": f"Bearer {token}"}

    async def _call(
        self, method: str, path: str, body: object = None, filter: str = ""
    ) -> dict[str, Any]:
        params = {"filter": filter, "limit": "20"} if filter else None
        res = await self.http.request(
            method, f"{self.base}{path}", headers=self.headers, json=body, params=params
        )
        if res.status_code == 400 and "duplicate entry" in res.text:
            raise Duplicate(path)
        res.raise_for_status()
        return obj(obj(res.json()).get("data"))

    async def _list(self, plural: str, filter: str) -> list[dict[str, Any]]:
        rows = (await self._call("GET", f"/{plural}", filter=filter)).get(plural)
        return [obj(r) for r in cast(list[object], rows)] if isinstance(rows, list) else []

    async def _find(self, plural: str, filter: str) -> dict[str, Any] | None:
        rows = await self._list(plural, filter)
        return rows[0] if rows else None

    async def _create(self, plural: str, singular: str, body: dict[str, Any], key: str) -> Any:
        """POST, or the row that won the race for the unique `key` filter."""
        try:
            return obj((await self._call("POST", f"/{plural}", body)).get(f"create{singular}"))
        except Duplicate:
            found = await self._find(plural, key)
            if found is None:
                raise
            return found

    async def _update(self, plural: str, singular: str, id: str, body: object) -> dict[str, Any]:
        return obj((await self._call("PATCH", f"/{plural}/{id}", body)).get(f"update{singular}"))

    async def person(self, *, app_user_id: str, email: str, name: str) -> Contact | None:
        by_user = f"appUserId[eq]:{_q(app_user_id)}"
        by_email = f"emails.primaryEmail[eq]:{_q(email)}"
        row = await self._find("people", by_user) if app_user_id else None
        if row is None and email:
            row = await self._find("people", by_email)
            if row is not None and app_user_id and not row.get("appUserId"):
                row = await self._update("people", "Person", row["id"], {"appUserId": app_user_id})
        if row is None:
            if not (app_user_id or email):
                return None
            first, _, last = name.strip().partition(" ")
            body: dict[str, Any] = {
                "name": {"firstName": first or email.split("@")[0], "lastName": last},
                "emails": {"primaryEmail": email},
            }
            if app_user_id:
                body["appUserId"] = app_user_id
            row = await self._create("people", "Person", body, by_user if app_user_id else by_email)
        return Contact(str(row["id"]), row.get("companyId"))

    async def company(self, app_org_id: str, name: str) -> str:
        key = f"appOrgId[eq]:{_q(app_org_id)}"
        row = await self._find("companies", key) or await self._create(
            "companies", "Company", {"name": name, "appOrgId": app_org_id}, key
        )
        return str(row["id"])

    async def join(self, person: Contact, company_id: str) -> None:
        if person.company_id is None:
            await self._update("people", "Person", person.id, {"companyId": company_id})

    async def deal(self, app_org_id: str, company_id: str, name: str, stage: str) -> None:
        key = f"appOrgId[eq]:{_q(app_org_id)}"
        row = await self._find("opportunities", key)
        if row is None:
            body = {"name": name, "stage": stage, "companyId": company_id, "appOrgId": app_org_id}
            row = await self._create("opportunities", "Opportunity", body, key)
        if row.get("stage") != stage:
            await self._update("opportunities", "Opportunity", row["id"], {"stage": stage})

    async def add_signal(self, company_id: str, signal: str) -> bool:
        # ponytail: read-modify-write; two signals for one company at the same instant can drop
        # one. Rare (one tag per event type) and the next event re-adds it.
        row = obj((await self._call("GET", f"/companies/{company_id}")).get("company"))
        signals: list[str] = list(row.get("productSignals") or [])
        if signal in signals:
            return False
        await self._update(
            "companies", "Company", company_id, {"productSignals": [*signals, signal]}
        )
        return True

    async def note(
        self, event_id: str, title: str, body: str, person: str | None, company: str | None
    ) -> bool:
        key = f"appEventId[eq]:{_q(event_id)}"
        found = await self._find("notes", key)
        row = found or await self._create(
            "notes",
            "Note",
            {"title": title, "bodyV2": {"markdown": body}, "appEventId": event_id},
            key,
        )
        # Targets after the note: a retry after a crash in between adds the missing ones.
        have = await self._list("noteTargets", f"noteId[eq]:{_q(row['id'])}")
        linked = {v for t in have for v in (t.get("targetPersonId"), t.get("targetCompanyId"))}
        for field, target in (("targetPersonId", person), ("targetCompanyId", company)):
            if target and target not in linked:
                await self._call("POST", "/noteTargets", {"noteId": row["id"], field: target})
        return found is None


BOOKING_TITLES = {
    "BOOKING_CREATED": "Booked",
    "BOOKING_RESCHEDULED": "Rescheduled",
    "BOOKING_CANCELLED": "Cancelled",
}


class Retry(ApplicationError):
    """The row the event refers to is not visible yet (the API's transaction may still be open)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, type="CrmRetry")


class CrmActivities:
    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        crm: Crm | None,
        config: CrmConfig,
        plans: Plans,
        chatwoot: Chatwoot | None,
        files: S3,
        booking_url: str,
    ) -> None:
        self.pool, self.crm, self.config, self.plans = pool, crm, config, plans
        self.chatwoot, self.files, self.booking_url = chatwoot, files, booking_url.rstrip("/")

    @activity.defn(name="crm_sync")
    async def sync(self, e: CrmEvent) -> str:
        """Applies one source event to the CRM; safe to retry (see the module docstring)."""
        if self.crm is None:
            log.info("dry run: TWENTY_API_URL/TWENTY_API_KEY unset, %s %s", e.kind, e.eventId)
            return "dry-run"
        handlers = {
            "user.created": self._user,
            "org.created": self._org,
            "billing": self._billing,
            "signal": self._signal,
            "support.conversation": self._support,
            "booking": self._booking,
        }
        handler = handlers.get(e.kind)
        if handler is None:
            raise ApplicationError(f"unknown CRM event kind {e.kind!r}", non_retryable=True)
        result = await handler(self.crm, e)
        activity.logger.info("crm %s %s: %s", e.kind, e.eventId, result)
        return result

    async def _app_person(self, crm: Crm, user_id: str) -> Contact | None:
        """The user's person; None while their email is unverified: matching by an address
        nobody proved to own would hand them a CRM person (a lead) who has it. The API syncs the
        person on verification (apps/api/src/auth.ts)."""
        row = await self.pool.fetchrow(
            'select name, email, email_verified from "user" where id = $1', user_id
        )
        if row is None:
            raise Retry(f"user {user_id} not found")
        if not row["email_verified"]:
            return None
        return await crm.person(app_user_id=user_id, email=row["email"], name=row["name"])

    async def _company(self, crm: Crm, org_id: str) -> str:
        name = await self.pool.fetchval("select name from organization where id = $1", org_id)
        if name is None:
            raise Retry(f"organization {org_id} not found")
        return await crm.company(org_id, name)

    async def _user(self, crm: Crm, e: CrmEvent) -> str:
        person = await self._app_person(crm, e.userId)
        if person is None:
            return "unverified"
        # Organizations created before the email was verified did not join the person.
        first = await self.pool.fetchval(
            "select organization_id from member where user_id = $1 order by created_at limit 1",
            e.userId,
        )
        if first:
            await crm.join(person, await self._company(crm, first))
        return "person"

    async def _org(self, crm: Crm, e: CrmEvent) -> str:
        company = await self._company(crm, e.orgId)
        person = await self._app_person(crm, e.userId) if e.userId else None
        if person is not None:
            await crm.join(person, company)
        return "company"

    async def _billing(self, crm: Crm, e: CrmEvent) -> str:
        """The stage follows our subscription row as it is now, not the event that triggered the
        sync: a retried, older event can then never move the deal back."""
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", e.orgId)
            status = await conn.fetchval("select status from subscriptions")
        stage = self.config.stages.get(status or "")
        if not stage:
            return "ignored"
        company = await self._company(crm, e.orgId)
        await crm.deal(e.orgId, company, self.config.deal_name, stage)
        return f"stage {stage}"

    async def _plan(self, org_id: str) -> str:
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", org_id)
            sub = await conn.fetchrow(
                "select plan_id, status, current_period_start, current_period_end"
                " from subscriptions"
            )
        return self.plans.effective(sub, datetime.now(UTC))[0]

    async def _signal(self, crm: Crm, e: CrmEvent) -> str:
        """The PostHog event says the user is active; whether their team qualifies (size, plan)
        is decided here from our own data, for each organization they belong to."""
        s = self.config.signals.get(e.signal)
        if s is None:
            return "ignored"
        orgs = await self.pool.fetch(
            "select o.id, (select count(*) from member x where x.organization_id = o.id) as members"
            " from member m join organization o on o.id = m.organization_id where m.user_id = $1",
            e.userId,
        )
        tagged = 0
        for org in orgs:
            if org["members"] < s.min_members or (
                s.plans and await self._plan(org["id"]) not in s.plans
            ):
                continue
            company = await self._company(crm, org["id"])
            if await crm.add_signal(company, s.name):
                tagged += 1
                body = f"{s.label}: {org['members']} members (PostHog event, synced by the app)."
                await crm.note(
                    f"{e.eventId}:{org['id']}", f"Signal: {s.label}", body, None, company
                )
        return f"tagged {tagged}"

    async def _support(self, crm: Crm, e: CrmEvent) -> str:
        if self.chatwoot is None:
            log.info(
                "crm: CHATWOOT_URL/CHATWOOT_API_TOKEN unset, conversation %s skipped", e.eventId
            )
            return "no-chatwoot"
        c = SupportConversation(e.accountId, e.conversationId)
        meta = obj((await self.chatwoot.conversation(c)).get("meta"))
        sender = obj(meta.get("sender"))
        # The identifier is our user id only when the widget's identity hash was verified.
        verified = meta.get("hmac_verified") is True
        person = await crm.person(
            app_user_id=str(sender.get("identifier") or "") if verified else "",
            email=str(sender.get("email") or ""),
            name=str(sender.get("name") or ""),
        )
        if person is None:
            return "anonymous"
        body = f"Support conversation opened: {self.chatwoot.link(c)}"
        title = f"Support conversation #{c.conversationId}"
        await crm.note(e.eventId, title, body, person.id, person.company_id)
        return "note"

    async def _booking(self, crm: Crm, e: CrmEvent) -> str:
        try:
            doc = json.loads(await self.files.get(e.bookingKey))
        except httpx2.HTTPStatusError as err:
            if err.response.status_code != 404:
                raise
            return "gone"  # deleted after an earlier attempt wrote the note, or by retention
        b = Booking(**doc)
        if b.trigger not in BOOKING_TITLES:
            return "ignored"
        person = await crm.person(app_user_id="", email=b.attendeeEmail, name=b.attendeeName)
        if person is not None:
            lines = [f"{BOOKING_TITLES[b.trigger]}: {b.title}, {b.startTime}"]
            if self.booking_url:
                lines.append(f"Booking: {self.booking_url}/booking/{b.uid}")
                if b.rescheduleUid:
                    lines.append(f"Earlier booking: {self.booking_url}/booking/{b.rescheduleUid}")
            title = f"{BOOKING_TITLES[b.trigger]}: {b.title}"
            await crm.note(e.eventId, title, "\n\n".join(lines), person.id, person.company_id)
        await self.files.delete(e.bookingKey)
        return "note" if person else "anonymous"
