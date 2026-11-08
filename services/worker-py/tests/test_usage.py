"""Usage reporting (worker/usage.py) and the pay-as-you-go spend limit, against the compose stack
and stripe-mock. Plans: config/plans.examples.json (`payg` meters llm_cost_micros, `growth`
api_calls)."""

import os
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import asyncpg
import httpx2
import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from tests.conftest import new_org
from tests.test_billing import call, fake, in_org, spend, subscribe
from worker import settings
from worker.ai import AllowedModel, Gateway
from worker.ai import Price as ModelPrice
from worker.billing import BillingActivities, BillingEvent, SpendLimitExceeded, load_plans
from worker.s3 import S3
from worker.usage import StripeCredits, StripeMeters, UsageActivities
from worker.usage import balance_cache as usage_balances
from worker.workflows import BillingEventWorkflow, CrmSyncWorkflow, UsageReportWorkflow

PLANS = load_plans(settings.PLANS_FILE.with_name("plans.examples.json"))


class FakeMeters:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, int, str]] = []

    async def report(
        self, customer_id: str, meter: str, value: int, identifier: str, at: datetime
    ) -> None:
        self.events.append((customer_id, meter, value, identifier))


@pytest.fixture(autouse=True)
def usage_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset({"billing-usage"}))


async def test_reports_each_call_and_closed_hour_once(pool: asyncpg.Pool) -> None:
    meters = FakeMeters()
    acts = UsageActivities(pool, PLANS, {"stripe": meters})
    payg, growth, flat = await new_org(pool), await new_org(pool), await new_org(pool)
    for org, plan in ((payg, "payg"), (growth, "growth"), (flat, "starter")):
        await subscribe(pool, org, plan_id=plan, customer_id=f"cus_{plan}_{org}")
    now = datetime.now(UTC)
    for org in (payg, flat):
        await spend(pool, org, "0.0123", now - timedelta(minutes=5))
    await spend(pool, payg, "1", now - timedelta(days=3))  # before the first window
    await spend(pool, payg, "1", now)  # not settled yet: next run
    closed = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    await in_org(
        pool,
        growth,
        "insert into usage_counters (org_id, meter, hour, count) values ($1, 'api_calls', $2, 42),"
        " ($1, 'api_calls', $3, 7)",
        growth,
        closed,
        closed + timedelta(hours=1),  # the current hour: still open
    )

    first = await acts.report_usage(None)
    [ai_call] = await in_org(
        pool, payg, "select id from ai_calls where created_at = $1", now - timedelta(minutes=5)
    )
    ours = lambda: sorted(e for e in meters.events if e[0].endswith((payg, growth, flat)))  # noqa: E731
    assert ours() == [
        (f"cus_growth_{growth}", "api_calls", 42, f"api_calls:{growth}:{closed:%Y%m%dT%H}"),
        (f"cus_payg_{payg}", "llm_cost_micros", 12300, f"llm_cost_micros:{ai_call['id']}"),
    ]  # the flat plan meters nothing
    meters.events.clear()
    await acts.report_usage(first["until"])  # next run: only what is new since
    assert ours() == []

    # Flag off: nothing is reported.
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(settings, "FLAGS_ON", frozenset[str]())
        assert (await acts.report_usage(None))["events"] == 0


async def test_usage_workflow_carries_the_window(pool: asyncpg.Pool) -> None:
    meters = FakeMeters()
    acts = UsageActivities(pool, PLANS, {"stripe": meters})
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    queue = f"test-{uuid.uuid4()}"
    async with Worker(
        client, task_queue=queue, workflows=[UsageReportWorkflow], activities=[acts.report_usage]
    ):
        result: dict[str, Any] = await client.execute_workflow(
            UsageReportWorkflow.run, id=f"usage-{uuid.uuid4()}", task_queue=queue
        )
    assert set(result) == {"until", "orgs", "events"}


async def test_stripe_meter_events_against_stripe_mock() -> None:
    url = os.environ.get("STRIPE_API_URL", "http://localhost:12111")
    async with httpx2.AsyncClient(timeout=10) as http:
        meters = StripeMeters(http, "sk_test_123", url)
        await meters.report("cus_1", "llm_cost_micros", 5, "llm_cost_micros:x", datetime.now(UTC))
        bad = StripeMeters(http, "sk_test_123", f"{url}/missing")
        with pytest.raises(RuntimeError, match="Stripe meter event failed: 404"):
            await bad.report("cus_1", "llm_tokens", 1, "llm_tokens:x", datetime.now(UTC))


async def test_pay_as_you_go_warns_over_the_plan_limit_and_stops_at_own_cap(
    pool: asyncpg.Pool, s3: S3, monkeypatch: pytest.MonkeyPatch
) -> None:
    gateway = Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={
            ("fake", "fake-model"): AllowedModel(
                frozenset({"project.summary"}), ModelPrice(Decimal("0.001"), Decimal(0), "USD")
            )
        },
        providers={"fake": fake},
        retention_days=1,
        plans=PLANS,
    )
    org = await new_org(pool)
    await subscribe(pool, org, plan_id="payg", customer_id="cus_1")
    await spend(pool, org, "150")  # over the plan's 100 USD
    await call(gateway, org)  # billed by usage: a warning, not a stop
    await in_org(pool, org, "update subscriptions set llm_spend_limits = $1", '{"USD": 120}')
    with pytest.raises(SpendLimitExceeded):  # the org's own cap
        await call(gateway, org)
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset[str]())
    await in_org(pool, org, "update subscriptions set llm_spend_limits = null")
    with pytest.raises(SpendLimitExceeded):  # flag off: the plan's limit stops calls as before
        await call(gateway, org)


class FakeCredits:
    def __init__(self, balance: int = 0) -> None:
        self.left = balance
        self.grants: list[tuple[str, str, int, datetime | None, str]] = []

    async def balance(self, customer_id: str, currency: str) -> int:
        return self.left

    async def grant(
        self, customer_id: str, currency: str, amount: int, expires: datetime | None, key: str
    ) -> None:
        self.grants.append((customer_id, currency, amount, expires, key))


async def test_paid_pack_is_granted_once_through_the_billing_workflow(pool: asyncpg.Pool) -> None:
    credits = FakeCredits()
    usage = UsageActivities(pool, PLANS, {}, {"stripe": credits})
    billing = BillingActivities(pool, PLANS)
    org = await new_org(pool)
    await subscribe(pool, org, plan_id="prepaid", customer_id="cus_1")
    at = datetime.now(UTC)
    e = BillingEvent(
        provider="stripe",
        contour="en",
        eventId=f"cs_{uuid.uuid4().hex}",
        type="credits.purchased",
        orgId=org,
        occurredAt=at.isoformat(),
        planId="prepaid",
        currency="USD",
        customerId="cus_1",
        amount=1000,
    )
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    queue = f"test-{uuid.uuid4()}"
    async with Worker(
        client,
        task_queue=queue,
        workflows=[BillingEventWorkflow, CrmSyncWorkflow],
        activities=[billing.apply_billing_event, usage.grant_credits, _crm_noop],
    ):
        await client.execute_workflow(
            BillingEventWorkflow.run, e, id=f"billing-stripe-{e.eventId}", task_queue=queue
        )
    assert await usage.grant_credits(e)  # a retry: same idempotency key for the provider
    key = f"credits-{e.eventId}"
    assert credits.grants == [("cus_1", "USD", 1000, at + timedelta(days=365), key)] * 2
    audit = await in_org(pool, org, "select action from audit_log order by action")
    assert [a["action"] for a in audit] == ["billing.credits.granted", "billing.credits.purchased"]


@activity.defn(name="crm_sync")
async def _crm_noop(_: Any) -> None:
    return None


async def test_calls_stop_when_the_prepaid_credit_is_used_up(
    pool: asyncpg.Pool, s3: S3, monkeypatch: pytest.MonkeyPatch
) -> None:
    credits = FakeCredits(balance=0)
    gateway = Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={
            ("fake", "fake-model"): AllowedModel(
                frozenset({"project.summary"}), ModelPrice(Decimal("0.001"), Decimal(0), "USD")
            )
        },
        providers={"fake": fake},
        retention_days=1,
        plans=PLANS,
        credits={"stripe": credits},
    )
    org = await new_org(pool)
    await subscribe(pool, org, plan_id="prepaid", customer_id="cus_1")
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset[str]())
    await call(gateway, org)  # flag off: no balance check
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset({"billing-credits"}))
    with pytest.raises(SpendLimitExceeded, match="prepaid credit is used up"):
        await call(gateway, org)
    usage_balances.pop(org)  # a new pack (grant_credits drops the cached balance)
    credits.left = 500
    await call(gateway, org)


async def test_stripe_credit_grants_against_stripe_mock() -> None:
    url = os.environ.get("STRIPE_API_URL", "http://localhost:12111")
    async with httpx2.AsyncClient(timeout=10) as http:
        stripe = StripeCredits(http, "sk_test_123", url)
        assert await stripe.balance("cus_1", "USD") == 0  # stripe-mock's fixture currency is fake
        await stripe.grant("cus_1", "USD", 1000, datetime.now(UTC) + timedelta(days=1), "k-1")
