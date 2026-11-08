"""RewardWorkflow end to end (real Temporal and Postgres): conditions, caps, the API call for money
rewards (canned HTTP), the operators' fallback and the llmSpendMonthly bonus (docs/growth.md)."""

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
    pool: asyncpg.Pool, r: RewardRequest, api: Api | None = None, configured: bool = True
) -> str:
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
        activities=[acts.eligible, acts.apply, acts.record],
    ):
        return await client.execute_workflow(
            RewardWorkflow.run,
            r,
            id=f"reward-{r.orgId}-{r.ruleId}-{r.subject}",  # as apps/api/src/temporal.ts
            task_queue=queue,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
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


async def test_invite_reward_needs_a_verified_member_and_respects_the_cap(
    pool: asyncpg.Pool,
) -> None:
    org_id = await new_org(pool)
    unverified = await new_user(pool, org_id, verified=False)
    left = await new_user(pool)  # accepted, then left before the hold ended
    assert await run(pool, RewardRequest(org_id, "team-invite", unverified, unverified)) == (
        "not eligible"
    )
    assert await run(pool, RewardRequest(org_id, "team-invite", left, left)) == "not eligible"
    api = Api(
        body={"via": "balance_credit", "reward": RULES["team-invite"]["reward"], "ref": "cb_1"}
    )
    for _ in range(RULES["team-invite"]["capPerOrg"] + 1):
        member = await new_user(pool, org_id)
        await run(pool, RewardRequest(org_id, "team-invite", member, member), api)
    rows = await grants(pool, org_id)
    assert len(rows) == RULES["team-invite"]["capPerOrg"]  # the one over the cap got nothing
    assert {(g["via"], g["provider_ref"]) for g in rows} == {("balance_credit", "cb_1")}
    sent = api.requests[0]
    assert sent.headers["authorization"] == "Bearer t0ken"
    assert json.loads(sent.content)["key"].startswith(f"reward-{org_id}-team-invite-")


async def test_money_reward_goes_to_operators_when_it_cannot_be_applied(
    pool: asyncpg.Pool,
) -> None:
    org_id = await new_org(pool)
    a, b = await new_user(pool, org_id), await new_user(pool, org_id)
    assert await run(pool, RewardRequest(org_id, "team-invite", a, a), Api(status=401)) == "manual"
    assert await run(pool, RewardRequest(org_id, "team-invite", b, b), configured=False) == "manual"
    rows = await grants(pool, org_id)
    assert [(g["status"], g["audit"]) for g in rows] == [
        ("pending_manual", "reward.pending_manual")
    ] * 2
    assert json.loads(rows[0]["reward"]) == RULES["team-invite"]["reward"]


async def test_llm_spend_bonus_counts_until_it_expires(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        for subject, expires in (("a", timedelta(days=1)), ("b", timedelta(seconds=-1))):
            await conn.execute(
                "insert into reward_grants (org_id, rule_id, subject, via, status, reward,"
                " expires_at) values ($1, 'r', $2, 'entitlement', 'applied', $3::jsonb,"
                " now() + $4::interval)",
                org_id,
                subject,
                json.dumps(
                    {"kind": "entitlement", "key": "llmSpendMonthly", "delta": 2, "months": 1}
                ),
                expires,
            )
        b = await llm_budget(conn, PLANS, org_id, "USD", datetime.now(UTC))
    assert b.limit == Decimal(1) + Decimal(2)  # free plan's limit + the unexpired reward


async def test_referral_fraud_guards(pool: asyncpg.Pool) -> None:
    async def org(domain: str, customer: str | None = None) -> str:
        org_id = await new_org(pool)
        await new_user(pool, org_id, email=f"{uuid.uuid4()}@{domain}")
        if customer:
            async with pool.acquire() as conn, conn.transaction():
                await conn.execute("select set_config('app.org_id', $1, true)", org_id)
                await conn.execute(
                    "insert into subscriptions (org_id, plan_id, status, contour, provider,"
                    " currency, customer_id)"
                    " values ($1, 'pro', 'active', 'en', 'stripe', 'USD', $2)",
                    org_id,
                    customer,
                )
        return org_id

    async def referral(referrer: str, referred: str, block: bool = True) -> str:
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
            activities=[acts.eligible, acts.apply, acts.record],
        ):
            return await client.execute_workflow(
                RewardWorkflow.run,
                RewardRequest(referrer, "referral", referred, f"org:{referred}"),
                id=f"reward-{referrer}-referral-{referred}-{uuid.uuid4()}",
                task_queue=queue,
            )

    a = await org("a.example.com", "cus_same")
    assert await referral(a, a) == "not eligible"  # self-referral
    assert await referral(a, await org("b.example.com", "cus_same")) == "not eligible"  # customer
    same_domain = await org("a.example.com", "cus_other")
    assert await referral(a, same_domain) == "not eligible"
    assert await referral(a, await org("a.example.com"), block=False) == "manual"  # no API link
    assert await referral(a, await org("c.example.com", "cus_c")) == "manual"
