"""Billing in the worker against the compose stack (Postgres, S3, Temporal): no provider network."""

import json
import logging
import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import asyncpg
import httpx2
import pytest
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from temporalio.client import Client
from temporalio.worker import Worker

from tests.conftest import new_org
from worker import settings
from worker.ai import AllowedModel, Completion, Gateway, Message, Price
from worker.billing import (
    BillingActivities,
    BillingEvent,
    Renewal,
    SpendLimitExceeded,
    YooKassa,
    llm_budget,
    load_plans,
)
from worker.s3 import S3
from worker.workflows import BillingEventWorkflow, SubscriptionRenewalWorkflow

PLANS = load_plans(settings.PLANS_FILE)
reader = InMemoryMetricReader()
metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
provider_calls: list[str] = []


async def fake(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
    provider_calls.append(model)
    return Completion("ok", model, 1000, 100, "fake-1")


@pytest.fixture(scope="module")
async def s3() -> AsyncIterator[S3]:
    s3 = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.AI_CONTENT_BUCKET,
    )
    await s3.ensure_bucket()
    yield s3
    await s3.close()


@pytest.fixture
def gateway(pool: asyncpg.Pool, s3: S3) -> Gateway:
    price = Price(Decimal("0.001"), Decimal("0.002"), "USD")  # 1000 in + 100 out = 0.0012
    return Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={("fake", "fake-model"): AllowedModel(frozenset({"project.summary"}), price)},
        providers={"fake": fake},
        retention_days=1,
        plans=PLANS,
    )


async def call(gateway: Gateway, org_id: str) -> Any:
    return await gateway.call_llm(
        "project.summary",
        [Message("user", "hi")],
        model="fake-model",
        provider="fake",
        org_id=org_id,
        actor_id=None,
        prompt_template_id="t",
        prompt_template_version="1",
        max_tokens=16,
    )


async def in_org(pool: asyncpg.Pool, org_id: str, sql: str, *args: Any) -> Any:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch(sql, *args)


async def spend(pool: asyncpg.Pool, org_id: str, cost: str, at: datetime | None = None) -> None:
    await in_org(
        pool,
        org_id,
        "insert into ai_calls (org_id, purpose, provider, request_model, prompt_template_id,"
        " prompt_template_version, request_key, content_expires_at, cost, cost_currency,"
        " latency_ms, status, contour, created_at)"
        " values ($1, 'project.summary', 'fake', 'fake-model', 't', '1', 'k', now(), $2, 'USD',"
        " 1, 'ok', 'eu', $3)",
        org_id,
        Decimal(cost),
        at or datetime.now(UTC),
    )


async def subscribe(pool: asyncpg.Pool, org_id: str, **over: Any) -> None:
    now = datetime.now(UTC)
    row: dict[str, Any] = {
        "plan_id": "pro",
        "status": "active",
        "contour": "ru",
        "provider": "yookassa",
        "currency": "RUB",
        "payment_method_id": "pm-1",
        "current_period_start": now - timedelta(days=1),
        "current_period_end": now + timedelta(days=29),
    } | over
    cols = ["org_id", *row]
    await in_org(
        pool,
        org_id,
        f"insert into subscriptions ({', '.join(cols)})"  # noqa: S608 - fixed column names
        f" values ({', '.join(f'${i + 1}' for i in range(len(cols)))})",
        org_id,
        *row.values(),
    )


def points(name: str) -> list[dict[str, Any]]:
    data = reader.get_metrics_data()
    doc: dict[str, Any] = json.loads(data.to_json()) if data else {"resource_metrics": []}
    return [
        p
        for rm in doc["resource_metrics"]
        for sm in rm["scope_metrics"]
        for m in sm["metrics"]
        if m["name"] == name
        for p in m["data"]["data_points"]
    ]


async def test_spend_limit_warns_at_80_and_blocks_at_100(
    gateway: Gateway, pool: asyncpg.Pool, caplog: pytest.LogCaptureFixture
) -> None:
    org_id = await new_org(pool)  # no subscription: free plan, 1 USD per calendar month
    await spend(pool, org_id, "0.85")
    with caplog.at_level(logging.WARNING, logger="worker.billing"):
        await call(gateway, org_id)
    assert "LLM spend at 85% of the limit" in caplog.text

    await spend(pool, org_id, "0.15")
    before = len(provider_calls)
    with pytest.raises(SpendLimitExceeded, match="spend limit for this billing period"):
        await call(gateway, org_id)
    assert len(provider_calls) == before  # the provider was never called
    rows = await in_org(pool, org_id, "select count(*) as n from ai_calls")
    assert rows[0]["n"] == 3  # two seeded + the one allowed call

    # Prometheus: labelled by plan and currency, never by org.
    [blocked] = [p for p in points("billing.llm_blocked") if p["attributes"]["plan"] == "free"]
    assert blocked["attributes"] == {"plan": "free", "currency": "USD"}
    assert blocked["value"] >= 1
    ratios = points("billing.llm_spend_ratio")
    assert ratios and all(set(p["attributes"]) == {"plan", "currency"} for p in ratios)


async def test_budget_uses_paid_period_and_raised_limit(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    await subscribe(pool, org_id, currency="USD", contour="en", provider="stripe")
    await spend(pool, org_id, "100", datetime.now(UTC) - timedelta(days=3))  # previous period
    await spend(pool, org_id, "30")

    async def budget() -> Any:
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", org_id)
            return await llm_budget(conn, PLANS, org_id, "USD", datetime.now(UTC))

    b = await budget()
    assert (b.plan_id, b.spent, b.limit) == ("pro", Decimal(30), Decimal(20))
    await in_org(pool, org_id, "update subscriptions set llm_spend_limits = $1", '{"USD": 50}')
    assert (await budget()).limit == Decimal(50)
    await in_org(pool, org_id, "update subscriptions set llm_spend_limits = $1", '{"USD": 9999}')
    assert (await budget()).limit == Decimal(200)  # capped by the plan's llmSpendMax


async def test_spend_sum_is_an_index_range_scan(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        await conn.execute("set local enable_seqscan = off")
        plan = "\n".join(
            r[0]
            for r in await conn.fetch(
                "explain select coalesce(sum(cost), 0) from ai_calls where org_id = $1"
                " and cost_currency = 'USD' and created_at >= now() - interval '1 month'"
                " and created_at < now()",
                org_id,
            )
        )
    assert "ai_calls_org_id_created_at_index" in plan, plan


def event(org_id: str, type: str, at: datetime, **over: Any) -> BillingEvent:
    fields: dict[str, Any] = {
        "provider": "stripe",
        "contour": "en",
        "eventId": f"evt_{uuid.uuid4().hex}",
        "type": type,
        "orgId": org_id,
        "occurredAt": at.isoformat(),
        "planId": "pro",
        "currency": "USD",
        "customerId": "cus_1",
        "subscriptionId": "sub_1",
        "periodStart": at.isoformat(),
        "periodEnd": (at + timedelta(days=30)).isoformat(),
        "cancelAtPeriodEnd": False,
    } | over
    return BillingEvent(**fields)


async def test_apply_event_is_idempotent_and_ignores_older_events(pool: asyncpg.Pool) -> None:
    acts = BillingActivities(pool, PLANS)
    org_id = await new_org(pool)
    t0 = datetime.now(UTC)
    activated = event(org_id, "subscription.activated", t0)

    assert await acts.apply_billing_event(activated)
    assert await acts.apply_billing_event(activated)  # redelivered / retried: same state
    canceled_late = event(org_id, "subscription.canceled", t0 - timedelta(minutes=1))
    assert not await acts.apply_billing_event(canceled_late)  # older than the stored state
    await acts.apply_billing_event(event(org_id, "payment.failed", t0, eventId="in_1"))
    await acts.apply_billing_event(event(org_id, "payment.failed", t0, eventId="in_1"))

    [sub] = await in_org(pool, org_id, "select * from subscriptions")
    assert (sub["plan_id"], sub["status"], sub["customer_id"]) == ("pro", "active", "cus_1")
    audit = await in_org(pool, org_id, "select action, target from audit_log order by action")
    assert [(a["action"], a["target"]) for a in audit] == [
        ("billing.payment.failed", "stripe:in_1"),
        ("billing.subscription.activated", f"stripe:{activated.eventId}"),
    ]

    assert await acts.apply_billing_event(event(org_id, "subscription.canceled", t0))
    [sub] = await in_org(pool, org_id, "select status, customer_id from subscriptions")
    assert (sub["status"], sub["customer_id"]) == ("canceled", "cus_1")


async def test_yookassa_renewal_charges_saved_method_once_per_period(pool: asyncpg.Pool) -> None:
    sent: list[httpx2.Request] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        sent.append(request)
        return httpx2.Response(200, json={"id": "p-2", "status": "succeeded"})

    yookassa = YooKassa(
        "local-dev-shop",
        "local_dev_yookassa_secret",
        "https://api.yookassa.example.com/v3",
        httpx2.AsyncClient(transport=httpx2.MockTransport(handle)),
    )
    acts = BillingActivities(pool, PLANS, yookassa)
    org_id = await new_org(pool)
    start = datetime.now(UTC) - timedelta(days=30, seconds=1)  # the period just ended
    activated = event(
        org_id,
        "subscription.activated",
        start,
        provider="yookassa",
        contour="ru",
        currency="RUB",
        customerId=None,
        subscriptionId=None,
        paymentMethodId="2f1b2c3d-000f-5000-8000-1a2b3c4d5e6f",
    )
    queue = f"test-{uuid.uuid4()}"
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    async with Worker(
        client,
        task_queue=queue,
        workflows=[BillingEventWorkflow, SubscriptionRenewalWorkflow],
        activities=[acts.apply_billing_event, acts.charge_renewal],
    ):
        assert await client.execute_workflow(
            BillingEventWorkflow.run,
            activated,
            id=f"billing-yookassa-{activated.eventId}",
            task_queue=queue,
        )
        renewal = client.get_workflow_handle(
            f"billing-renewal-{org_id}-{activated.periodEnd}", result_type=str
        )
        assert await renewal.result() == "succeeded"

    [req] = sent
    body = json.loads(req.content)
    assert body == {
        "amount": {"value": "2490.00", "currency": "RUB"},
        "capture": True,
        "payment_method_id": "2f1b2c3d-000f-5000-8000-1a2b3c4d5e6f",
        "description": "Pro subscription renewal",
        "metadata": {
            "orgId": org_id,
            "planId": "pro",
            "kind": "renewal",
            "periodStart": activated.periodEnd,
        },
    }
    assert req.headers["authorization"].startswith("Basic ")
    key = req.headers["idempotence-key"]
    # A retried charge for the same period reuses the key: YooKassa will not charge twice.
    assert activated.periodEnd
    await acts.charge_renewal(Renewal(org_id, activated.periodEnd))
    assert sent[-1].headers["idempotence-key"] == key

    # Canceled before the period end: the renewal ends the subscription instead of charging.
    await in_org(pool, org_id, "update subscriptions set cancel_at_period_end = true")
    assert await acts.charge_renewal(Renewal(org_id, activated.periodEnd)) == "canceled"
    assert len(sent) == 2
    [sub] = await in_org(pool, org_id, "select status from subscriptions")
    assert sub["status"] == "canceled"
