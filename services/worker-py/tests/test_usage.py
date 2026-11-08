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
from temporalio.client import Client
from temporalio.worker import Worker

from tests.conftest import new_org
from tests.test_billing import call, fake, in_org, spend, subscribe
from worker import settings
from worker.ai import AllowedModel, Gateway
from worker.ai import Price as ModelPrice
from worker.billing import SpendLimitExceeded, load_plans
from worker.s3 import S3
from worker.usage import StripeMeters, UsageActivities
from worker.workflows import UsageReportWorkflow

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
