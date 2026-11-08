"""Usage reporting (worker/usage.py) and the pay-as-you-go spend limit, against the compose stack
and stripe-mock. Plans: the API's test fixture (`payg` meters llm_cost_micros, `growth`
api_calls, `starter` is flat)."""

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
from tests.test_billing import FIXTURE_PLANS, call, fake, in_org, spend, subscribe
from worker import settings
from worker.ai import AllowedModel, Gateway
from worker.ai import Price as ModelPrice
from worker.billing import SpendLimitExceeded, load_plans
from worker.s3 import S3
from worker.usage import StripeMeters, UsageActivities
from worker.workflows import UsageReportWorkflow

PLANS = load_plans(FIXTURE_PLANS)
HOUR = timedelta(hours=1)


class FakeMeters:
    def __init__(self, failing: frozenset[str] = frozenset()) -> None:
        self.events: list[tuple[str, str, int, str]] = []
        self.failing = failing

    async def report(
        self, customer_id: str, meter: str, value: int, identifier: str, at: datetime
    ) -> None:
        if customer_id in self.failing:
            raise RuntimeError("Stripe meter event failed: 500 None")
        self.events.append((customer_id, meter, value, identifier))


@pytest.fixture(autouse=True)
def usage_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset({"billing-usage"}))


def closed_hour() -> datetime:
    """The last hour that is closed for reporting (worker/usage.py SETTLE is 5 minutes)."""
    return (datetime.now(UTC) - timedelta(minutes=5)).replace(
        minute=0, second=0, microsecond=0
    ) - HOUR


async def metered_org(pool: asyncpg.Pool, plan: str, hour: datetime) -> str:
    org = await new_org(pool)
    await subscribe(pool, org, plan_id=plan, customer_id=f"cus_{org}", usage_reported_until=hour)
    return org


async def test_one_event_per_meter_and_hour_and_an_idempotent_rerun(pool: asyncpg.Pool) -> None:
    meters = FakeMeters()
    acts = UsageActivities(pool, PLANS, {"stripe": meters})
    hour = closed_hour()
    payg, growth, flat = [await metered_org(pool, p, hour) for p in ("payg", "growth", "starter")]
    for org in (payg, flat):
        await spend(pool, org, "0.000004", hour + timedelta(minutes=1))
        await spend(pool, org, "0.000004", hour + timedelta(minutes=2))  # one event: 8 micros
    await in_org(  # another currency never lands on a USD meter
        pool,
        payg,
        "insert into ai_calls (org_id, purpose, provider, request_model, prompt_template_id,"
        " prompt_template_version, request_key, content_expires_at, cost, cost_currency,"
        " latency_ms, status, contour, created_at) values ($1, 'project.summary', 'fake', 'm',"
        " 't', '1', 'k', now(), 5, 'EUR', 1, 'ok', 'eu', $2)",
        payg,
        hour + timedelta(minutes=3),
    )
    await spend(pool, payg, "1", hour + HOUR + timedelta(minutes=1))  # the open hour: later
    await in_org(
        pool,
        growth,
        "insert into usage_counters (org_id, meter, hour, count) values ($1, 'api_calls', $2, 42)",
        growth,
        hour,
    )

    assert [await acts.report_org_usage(o) for o in (payg, growth, flat)] == [1, 1, 0]
    stamp = f"{hour:%Y%m%dT%H}"
    assert sorted(meters.events) == sorted(
        [
            (f"cus_{payg}", "llm_cost_micros", 8, f"llm_cost_micros:{payg}:{stamp}"),
            (f"cus_{growth}", "api_calls", 42, f"api_calls:{growth}:{stamp}"),
        ]
    )
    [sub] = await in_org(pool, payg, "select usage_reported_until from subscriptions")
    assert sub["usage_reported_until"] == hour + HOUR

    # A re-run sends nothing new; replaying the hour sends the same identifiers (deduplicated).
    assert await acts.report_org_usage(payg) == 0
    await in_org(pool, payg, "update subscriptions set usage_reported_until = $1", hour)
    first = meters.events[:]
    await acts.report_org_usage(payg)
    assert meters.events[len(first) :] == [e for e in first if e[0] == f"cus_{payg}"]


async def test_plan_in_effect_per_hour_and_the_flag_per_org(
    pool: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    meters = FakeMeters()
    acts = UsageActivities(pool, PLANS, {"stripe": meters})
    hour = closed_hour()
    org = await metered_org(pool, "payg", hour)
    await spend(pool, org, "0.01", hour + timedelta(minutes=1))
    # Canceled now, but the hour lies in its last period: still billed.
    await in_org(
        pool,
        org,
        "update subscriptions set status = 'canceled', current_period_end = $1",
        hour + HOUR,
    )
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset[str]())
    assert await acts.report_org_usage(org) == 0  # flag off for this org
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset({"billing-usage"}))
    assert await acts.report_org_usage(org) == 1
    assert meters.events[-1][1:3] == ("llm_cost_micros", 10000)


async def test_a_failing_org_does_not_hold_up_the_others(pool: asyncpg.Pool) -> None:
    hour = closed_hour()
    bad, good = await metered_org(pool, "payg", hour), await metered_org(pool, "payg", hour)
    for org in (bad, good):
        await spend(pool, org, "0.01", hour + timedelta(minutes=1))
    meters = FakeMeters(failing=frozenset({f"cus_{bad}"}))
    acts = UsageActivities(pool, PLANS, {"stripe": meters})
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    queue = f"test-{uuid.uuid4()}"
    async with Worker(
        client,
        task_queue=queue,
        workflows=[UsageReportWorkflow],
        activities=[acts.usage_orgs, acts.report_org_usage],
    ):
        result: dict[str, Any] = await client.execute_workflow(
            UsageReportWorkflow.run, id=f"usage-{uuid.uuid4()}", task_queue=queue
        )
    assert result["failed"] >= 1
    assert any(e[0] == f"cus_{good}" for e in meters.events)
    for org, mark in ((bad, hour), (good, hour + HOUR)):
        [sub] = await in_org(pool, org, "select usage_reported_until from subscriptions")
        assert sub["usage_reported_until"] == mark  # the bad org retries from its own mark


async def test_stripe_meter_events_against_stripe_mock() -> None:
    url = os.environ.get("STRIPE_API_URL", "http://localhost:12111")
    async with httpx2.AsyncClient(timeout=10) as http:
        meters = StripeMeters(http, "sk_test_123", url)
        await meters.report("cus_1", "llm_cost_micros", 5, "llm_cost_micros:x", datetime.now(UTC))
        bad = StripeMeters(http, "sk_test_123", f"{url}/missing")
        with pytest.raises(RuntimeError, match="Stripe meter event failed: 404"):
            await bad.report("cus_1", "llm_tokens", 1, "llm_tokens:x", datetime.now(UTC))


async def test_pay_as_you_go_warns_over_the_plan_limit_and_stops_at_a_cap(
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
    await in_org(pool, org, "update subscriptions set llm_spend_limits = null")
    await spend(pool, org, "4850")
    with pytest.raises(SpendLimitExceeded):  # no own cap: the plan's llmSpendMax (5000)
        await call(gateway, org)
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset[str]())
    with pytest.raises(SpendLimitExceeded):  # flag off: the plan's limit stops calls as before
        await call(gateway, org)
