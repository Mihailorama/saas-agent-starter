"""RewardWorkflow end to end (real Temporal and Postgres): conditions, caps, the API call for money
rewards (canned HTTP), the operators' fallback and the llmSpendMonthly bonus (docs/growth.md)."""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import asyncpg
import httpx2
import pytest
from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.worker import Worker

from tests.conftest import new_org
from tests.test_billing import PLANS
from tests.test_crm import new_user
from worker import settings
from worker.billing import llm_budget
from worker.rewards import RewardActivities, RewardRequest, load_rules
from worker.workflows import RewardWorkflow

RULES = load_rules(settings.REWARDS_FILE)


class Api:
    """The API's POST /internal/rewards/apply, canned."""

    def __init__(self, status: int = 200, body: dict[str, Any] | None = None) -> None:
        self.status, self.body, self.requests = status, body, list[httpx2.Request]()

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return httpx2.Response(self.status, json=self.body or {"error": "x"})


async def run(
    pool: asyncpg.Pool,
    r: RewardRequest | list[RewardRequest],
    api: Api | None = None,
    configured: bool = True,
    suffix: str = "",
) -> Any:
    """Runs one workflow (or several at once) on a fresh worker; `suffix` = a new workflow id."""
    http = httpx2.AsyncClient(transport=httpx2.MockTransport((api or Api()).handle))
    acts = RewardActivities(
        pool, RULES, http, "http://api:3000" if configured else "", "t0ken" if configured else ""
    )
    queue = f"test-{uuid.uuid4()}"
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    async with Worker(
        client,
        task_queue=queue,
        workflows=[RewardWorkflow],
        activities=[acts.reserve, acts.apply, acts.record],
    ):

        async def start(x: RewardRequest) -> str:
            return await client.execute_workflow(
                RewardWorkflow.run,
                x,
                id=f"reward-{x.orgId}-{x.ruleId}-{x.subject}{suffix}",  # as apps/api/temporal.ts
                task_queue=queue,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )

        if isinstance(r, list):
            return await asyncio.gather(*(start(x) for x in r))
        return await start(r)


async def invitee(pool: asyncpg.Pool, org_id: str, verified: bool = True) -> str:
    """A member who joined through an accepted invitation, as Better Auth leaves it."""
    user_id = await new_user(pool, org_id, verified=verified)
    await accept(pool, org_id, user_id)
    return user_id


async def accept(pool: asyncpg.Pool, org_id: str, user_id: str) -> None:
    await pool.execute(
        "insert into invitation (id, organization_id, email, role, status, expires_at,"
        " inviter_id) select $1, $2, email, 'member', 'accepted', now(), id from \"user\""
        " where id = $3",
        str(uuid.uuid4()),
        org_id,
        user_id,
    )


async def grants(pool: asyncpg.Pool, org_id: str) -> list[asyncpg.Record]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch(
            "select g.*, (select action from audit_log a where a.target = g.id::text) as audit"
            " from reward_grants g order by created_at"
        )


async def test_profile_reward_once_when_complete(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    r = RewardRequest(orgId=org_id, ruleId="org-profile", subject=org_id, userId="u")
    assert await run(pool, r) == "not eligible"  # no metadata yet
    await pool.execute(
        "update organization set metadata = $2 where id = $1",
        org_id,
        json.dumps({"website": "https://example.com", "size": "11-50"}),
    )
    r2 = RewardRequest(orgId=org_id, ruleId="org-profile", subject=org_id, userId="u2")
    with pytest.raises(WorkflowAlreadyStartedError):  # the id already ran: never twice
        await run(pool, r2)
    other = await new_org(pool)
    await pool.execute(
        "update organization set metadata = $2 where id = $1",
        other,
        json.dumps({"website": "https://example.com", "size": "11-50"}),
    )
    assert await run(pool, RewardRequest(other, "org-profile", other, "u")) == "entitlement"
    [g] = await grants(pool, other)
    assert (g["via"], g["status"], g["audit"]) == ("entitlement", "applied", "reward.applied")
    assert g["expires_at"].year >= datetime.now(UTC).year  # 12 months from now


async def test_invite_reward_guards(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    unverified = await invitee(pool, org_id, verified=False)
    left = await new_user(pool)  # accepted, then left before the hold ended
    await accept(pool, org_id, left)
    assert await run(pool, RewardRequest(org_id, "team-invite", unverified, unverified)) == (
        "not eligible"
    )
    assert await run(pool, RewardRequest(org_id, "team-invite", left, left)) == "not eligible"
    api = Api(
        body={"via": "balance_credit", "reward": RULES["team-invite"]["reward"], "ref": "cb_1"}
    )
    member = await invitee(pool, org_id)
    r = RewardRequest(org_id, "team-invite", member, member)
    assert await run(pool, r, api) == "balance_credit"
    # Temporal forgot the id (retention): a new run for the same subject still gets nothing.
    assert await run(pool, r, api, suffix="-again") == "not eligible"
    # The same account invited by another org (farming): it counted for the first one, ever.
    other = await new_org(pool)
    await pool.execute(
        "insert into member (id, organization_id, user_id, role, created_at)"
        " values ($1, $2, $3, 'member', now())",
        str(uuid.uuid4()),
        other,
        member,
    )
    await accept(pool, other, member)
    assert await run(pool, RewardRequest(other, "team-invite", member, member), api) == (
        "not eligible"
    )
    sent = api.requests[0]
    assert sent.headers["authorization"] == "Bearer t0ken"
    assert json.loads(sent.content)["key"] == f"reward-{org_id}-team-invite-{member}"
    [g] = await grants(pool, org_id)
    assert (g["status"], g["via"], g["provider_ref"]) == ("applied", "balance_credit", "cb_1")


async def test_reruns_settle_without_crediting_twice(pool: asyncpg.Pool) -> None:
    """A reservation found again: applied before = settle with the stored ref, no API call;
    older than a day without it = operators (the provider key may have expired)."""
    org_id = await new_org(pool)
    applied, stale = await invitee(pool, org_id), await invitee(pool, org_id)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        for subject, via, ref, age in (
            (applied, "balance_credit", "cbtxn_1", timedelta(0)),
            (stale, None, None, timedelta(days=2)),
        ):
            await conn.execute(
                "insert into reward_grants (org_id, rule_id, subject, status, via, reward,"
                " idempotency_key, provider_ref, created_at) values ($1, 'team-invite', $2,"
                " 'reserved', $3, $4::jsonb, $5, $6, now() - $7::interval)",
                org_id,
                subject,
                via,
                json.dumps(RULES["team-invite"]["reward"]),
                f"reward-{org_id}-team-invite-{subject}",
                ref,
                age,
            )
    api = Api(body={"via": "balance_credit", "reward": {}, "ref": "cbtxn_2"})
    assert await run(pool, RewardRequest(org_id, "team-invite", applied, applied), api) == (
        "balance_credit"
    )
    assert await run(pool, RewardRequest(org_id, "team-invite", stale, stale), api) == "manual"
    assert api.requests == []  # the provider was not called again
    rows = {g["subject"]: g for g in await grants(pool, org_id)}
    assert (rows[applied]["status"], rows[applied]["provider_ref"]) == ("applied", "cbtxn_1")
    assert rows[stale]["status"] == "pending_manual"


async def test_cap_holds_under_concurrent_grants(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    cap = RULES["team-invite"]["capPerOrg"]
    members = [await invitee(pool, org_id) for _ in range(cap + 3)]
    results = await run(
        pool, [RewardRequest(org_id, "team-invite", m, m) for m in members], configured=False
    )
    assert sorted(results).count("not eligible") == 3
    assert len(await grants(pool, org_id)) == cap


async def test_money_reward_goes_to_operators_when_it_cannot_be_applied(
    pool: asyncpg.Pool,
) -> None:
    org_id = await new_org(pool)
    a, b = await invitee(pool, org_id), await invitee(pool, org_id)
    assert await run(pool, RewardRequest(org_id, "team-invite", a, a), Api(status=401)) == "manual"
    assert await run(pool, RewardRequest(org_id, "team-invite", b, b), configured=False) == "manual"
    rows = await grants(pool, org_id)
    assert [(g["status"], g["audit"]) for g in rows] == [
        ("pending_manual", "reward.pending_manual")
    ] * 2
    assert json.loads(rows[0]["reward"]) == RULES["team-invite"]["reward"]
    assert rows[0]["idempotency_key"] == f"reward-{org_id}-team-invite-{a}"  # shown to operators


async def test_llm_spend_bonus_counts_until_it_expires(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        for subject, expires in (("a", timedelta(days=1)), ("b", timedelta(seconds=-1))):
            await conn.execute(
                "insert into reward_grants (org_id, rule_id, subject, via, status, reward,"
                " idempotency_key, expires_at) values ($1, 'r', $2, 'entitlement', 'applied',"
                " $3::jsonb, $2, now() + $4::interval)",
                org_id,
                subject,
                json.dumps(
                    {
                        "kind": "entitlement",
                        "key": "llmSpendMonthly",
                        "delta": 2,
                        "months": 1,
                        "currency": "USD",
                    }
                ),
                expires,
            )
        b = await llm_budget(conn, PLANS, org_id, "USD", datetime.now(UTC))
        eur = await llm_budget(conn, PLANS, org_id, "EUR", datetime.now(UTC))
    assert b.limit == Decimal(1) + Decimal(2)  # free plan's limit + the unexpired reward
    assert eur.limit == Decimal(1)  # only in the reward's currency


async def test_referral_guards(pool: asyncpg.Pool) -> None:
    async def org(domain: str, status: str | None = "active", ending: bool = False) -> str:
        org_id = await new_org(pool)
        await new_user(pool, org_id, email=f"{uuid.uuid4()}@{domain}")
        if status:
            async with pool.acquire() as conn, conn.transaction():
                await conn.execute("select set_config('app.org_id', $1, true)", org_id)
                await conn.execute(
                    "insert into subscriptions (org_id, plan_id, status, contour, provider,"
                    " currency, customer_id, cancel_at_period_end)"
                    " values ($1, 'pro', $2, 'en', 'stripe', 'USD', $1, $3)",
                    org_id,
                    status,
                    ending,
                )
        return org_id

    async def referral(referrer: str, referred: str, block: bool = False) -> str:
        http = httpx2.AsyncClient(transport=httpx2.MockTransport(Api().handle))
        acts = RewardActivities(pool, RULES, http, "", "", block_same_domain=block)
        queue = f"test-{uuid.uuid4()}"
        client = await Client.connect(
            settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE
        )
        async with Worker(
            client,
            task_queue=queue,
            workflows=[RewardWorkflow],
            activities=[acts.reserve, acts.apply, acts.record],
        ):
            return await client.execute_workflow(
                RewardWorkflow.run,
                RewardRequest(referrer, "referral", referred, f"org:{referred}"),
                id=f"reward-{referrer}-referral-{referred}",
                task_queue=queue,
            )

    a = await org("a.example.com", status=None)  # a free referrer
    assert await referral(a, a) == "not eligible"  # self-referral
    assert await referral(a, await org("b.example.com", "canceled")) == "not eligible"  # refunded
    ending = await org("b.example.com", ending=True)  # paid once, then cancel at period end
    assert await referral(a, ending) == "not eligible"
    assert await referral(a, await org("a.example.com"), block=True) == "not eligible"
    assert await referral(a, await org("a.example.com")) == "manual"  # guard off; no API link
    assert await referral(a, await org("c.example.com")) == "manual"
