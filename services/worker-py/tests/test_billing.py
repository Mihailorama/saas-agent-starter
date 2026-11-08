"""Billing in the worker against the compose stack (Postgres, S3, Temporal): no provider network."""

import json
import logging
import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import asyncpg
import pytest
from litellm.exceptions import RateLimitError
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.worker import Worker

from tests.conftest import new_org
from worker import settings
from worker.ai import (
    AllowedModel,
    Completion,
    Fallback,
    Gateway,
    Message,
    ModelNotAllowed,
    load_registry,
)
from worker.ai import Price as ModelPrice
from worker.billing import (
    BillingActivities,
    BillingEvent,
    ContractPeriod,
    Price,
    SpendLimitExceeded,
    UsageLimitExceeded,
    llm_budget,
    load_plans,
)
from worker.providers import ProviderConfig, load_providers
from worker.s3 import S3
from worker.workflows import BillingEventWorkflow, ContractPeriodWorkflow

PLANS = load_plans(settings.PLANS_FILE)
reader = InMemoryMetricReader()
metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
provider_calls: list[str] = []


async def fake(
    model: str, messages: Sequence[Message], max_tokens: int, _tools: object = ()
) -> Completion:
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
    price = ModelPrice(Decimal("0.001"), Decimal("0.002"), "USD")  # 1000 in + 100 out = 0.0012
    return Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={
            ("fake", "fake-model"): AllowedModel(frozenset({"project.summary"}), price),
            ("fake", "unpriced"): AllowedModel(frozenset({"project.summary"}), None),
            ("fake", "self-hosted"): AllowedModel(
                frozenset({"project.summary"}), None, unmetered=True
            ),
        },
        providers={"fake": fake},
        retention_days=1,
        plans=PLANS,
    )


async def call(gateway: Gateway, org_id: str, model: str = "fake-model") -> Any:
    return await gateway.call_llm(
        "project.summary",
        [Message("user", "hi")],
        model=model,
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
        "contour": "en",
        "provider": "stripe",
        "currency": "USD",
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


async def test_unpriced_models_fail_closed_unless_unmetered(
    gateway: Gateway, pool: asyncpg.Pool
) -> None:
    org_id = await new_org(pool)
    before = len(provider_calls)
    with pytest.raises(ModelNotAllowed, match="no price"):
        await call(gateway, org_id, "unpriced")
    assert len(provider_calls) == before
    assert await in_org(pool, org_id, "select id from ai_calls") == []

    # Explicitly unmetered: allowed, row without cost, never counted against the limit.
    await spend(pool, org_id, "5")  # far over the free plan's 1 USD
    await call(gateway, org_id, "self-hosted")
    rows = await in_org(
        pool, org_id, "select cost from ai_calls where request_model = $1", "self-hosted"
    )
    assert [r["cost"] for r in rows] == [None]
    with pytest.raises(SpendLimitExceeded):  # priced models are still limited
        await call(gateway, org_id)


def test_shipped_unpriced_placeholder_is_refused_until_configured() -> None:
    placeholder = load_registry(settings.AI_MODELS_FILE, "ru")[
        ("openai_compatible", "example-self-hosted-model")
    ]
    assert (placeholder.price, placeholder.unmetered) == (None, False)


async def test_budget_uses_paid_period_and_raised_limit(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    await subscribe(pool, org_id)
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


async def test_billing_event_workflow_applies_once(pool: asyncpg.Pool) -> None:
    acts = BillingActivities(pool, PLANS)
    org_id = await new_org(pool)
    e = event(org_id, "subscription.activated", datetime.now(UTC))
    queue = f"test-{uuid.uuid4()}"
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    workflow_id = f"billing-{e.provider}-{e.eventId}"  # same scheme as apps/api/src/temporal.ts
    async with Worker(
        client,
        task_queue=queue,
        workflows=[BillingEventWorkflow],
        activities=[acts.apply_billing_event],
    ):
        start = lambda: client.execute_workflow(  # noqa: E731
            BillingEventWorkflow.run,
            e,
            id=workflow_id,
            task_queue=queue,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
        )
        assert await start()
        with pytest.raises(WorkflowAlreadyStartedError):  # redelivered webhook: not run again
            await start()
    [sub] = await in_org(pool, org_id, "select plan_id, status from subscriptions")
    assert (sub["plan_id"], sub["status"]) == ("pro", "active")


async def unmetered_calls(pool: asyncpg.Pool, org_id: str, n: int, tokens: int = 10) -> None:
    await in_org(
        pool,
        org_id,
        "insert into ai_calls (org_id, purpose, provider, request_model, prompt_template_id,"
        " prompt_template_version, request_key, content_expires_at, total_tokens, latency_ms,"
        " status, contour) select $1, 'project.summary', 'fake', 'self-hosted', 't', '1', 'k',"
        " now(), $3, 1, 'ok', 'eu' from generate_series(1, $2)",
        org_id,
        n,
        tokens,
    )


async def test_unmetered_models_are_limited_by_calls_and_tokens(
    gateway: Gateway, pool: asyncpg.Pool
) -> None:
    usage = PLANS.plans["free"].llm_usage_monthly
    assert usage == {"calls": 200, "tokens": 400000}
    calls = await new_org(pool)
    await unmetered_calls(pool, calls, usage["calls"] - 1)
    await spend(pool, calls, "0.5")  # priced calls do not count against the usage limit
    await call(gateway, calls, "self-hosted")  # the 200th call is allowed
    before = len(provider_calls)
    with pytest.raises(UsageLimitExceeded, match=r"usage limit \(calls\)"):
        await call(gateway, calls, "self-hosted")
    assert len(provider_calls) == before
    await call(gateway, calls)  # priced models follow the money limit only

    tokens = await new_org(pool)
    await unmetered_calls(pool, tokens, 1, usage["tokens"])
    with pytest.raises(UsageLimitExceeded, match=r"usage limit \(tokens\)"):
        await call(gateway, tokens, "self-hosted")
    assert issubclass(UsageLimitExceeded, SpendLimitExceeded)  # activities handle both alike

    paid = await new_org(pool)  # pro: 5000 calls
    await subscribe(pool, paid)
    await unmetered_calls(pool, paid, usage["calls"])
    await call(gateway, paid, "self-hosted")


async def rate_limited(
    model: str, messages: Sequence[Message], max_tokens: int, _tools: object = ()
) -> Completion:
    raise RateLimitError("429 from the subscription", llm_provider="openai", model=model)


async def test_rate_limited_call_falls_back_once(pool: asyncpg.Pool, s3: S3) -> None:
    allowed = frozenset({"project.summary"})
    gateway = Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={
            ("sub", "m"): AllowedModel(allowed, None, True, Fallback("fake", "self-hosted")),
            ("fake", "self-hosted"): AllowedModel(allowed, None, True, Fallback("sub", "m")),
            ("sub", "no-fallback"): AllowedModel(allowed, None, True),
            ("sub", "to-unconfigured"): AllowedModel(allowed, None, True, Fallback("api", "x")),
            ("api", "x"): AllowedModel(allowed, ModelPrice(Decimal(1), Decimal(1), "USD")),
        },
        providers={"sub": rate_limited, "fake": fake, "api": fake},
        provider_configs={
            "api": ProviderConfig("api", "api", "anthropic", None, None, 10)  # no key
        },
        retention_days=1,
        plans=PLANS,
    )
    org_id = await new_org(pool)
    result = await gateway.call_llm(
        "project.summary",
        [Message("user", "hi")],
        model="m",
        provider="sub",
        org_id=org_id,
        actor_id=None,
        prompt_template_id="t",
        prompt_template_version="1",
        max_tokens=16,
    )
    assert result.text == "ok"
    rows = await in_org(
        pool, org_id, "select provider, status, error_class from ai_calls order by created_at"
    )
    assert [tuple(r) for r in rows] == [
        ("sub", "error", "RateLimitError"),  # every attempt is on the record
        ("fake", "ok", None),
    ]
    for model in ("no-fallback", "to-unconfigured"):
        with pytest.raises(RateLimitError):
            await gateway.call_llm(
                "project.summary",
                [Message("user", "hi")],
                model=model,
                provider="sub",
                org_id=org_id,
                actor_id=None,
                prompt_template_id="t",
                prompt_template_version="1",
                max_tokens=16,
            )


def test_price_override_wins_then_litellm_map_then_refusal() -> None:
    configs = load_providers(
        settings.AI_MODELS_FILE,
        {"ANTHROPIC_API_KEY": "local-dev-anthropic"},
        cli_url="",
        cli_token="",
        timeout=1,
        cli_timeout=1,
    )
    registry = load_registry(settings.AI_MODELS_FILE, "eu")
    gw = Gateway(
        pool=None,  # type: ignore[arg-type] - price lookups only
        s3=None,  # type: ignore[arg-type]
        contour="eu",
        registry=registry
        | {
            ("anthropic", "overridden"): AllowedModel(
                frozenset(), ModelPrice(Decimal(5), Decimal(6), "EUR")
            )
        }
        | {("anthropic", "unknown-model"): AllowedModel(frozenset({"project.summary"}), None)},
        providers={"anthropic": fake},
        provider_configs=configs,
        retention_days=1,
    )
    assert gw.price_of("anthropic", "claude-haiku-5-5") == ModelPrice(
        Decimal("0.0001"), Decimal("0.0005"), "USD"
    )
    assert gw.price_of("anthropic", "overridden") == ModelPrice(Decimal(5), Decimal(6), "EUR")
    assert gw.price_of("claude_cli", "claude-haiku-5-5") is None  # subscription: unmetered
    with pytest.raises(ModelNotAllowed, match="no price"):
        gw._route("project.summary", "anthropic", "unknown-model")  # pyright: ignore[reportPrivateUsage]


def test_price_models_parse_and_old_prices_stay_flat() -> None:
    assert PLANS.plans["pro"].prices["USD"] == [Price("flat", "29.00", "month")]  # no `model`
    examples = load_plans(settings.PLANS_FILE.with_name("plans.examples.json")).plans
    assert [p.model for p in examples["growth"].prices["USD"]] == ["flat", "metered"]
    pack = Price("credits", None, None, "llm_cost_micros", 365)
    assert examples["prepaid"].prices["USD"][1] == pack
    assert examples["enterprise"].prices["USD"] == [Price("contract")]


async def test_contract_period_end_marks_past_due_once(pool: asyncpg.Pool) -> None:
    acts = BillingActivities(pool, PLANS)
    org_id, renewed = await new_org(pool), await new_org(pool)
    end = datetime.now(UTC).replace(microsecond=0) + timedelta(seconds=2)
    for org in (org_id, renewed):
        await subscribe(pool, org, provider="manual", current_period_end=end, contract_ref="PO-1")
    # An operator extended this one before the timer fired: the old timer changes nothing.
    await in_org(pool, renewed, "update subscriptions set current_period_end = $1", end + DAYS)
    queue = f"test-{uuid.uuid4()}"
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    async with Worker(
        client,
        task_queue=queue,
        workflows=[ContractPeriodWorkflow],
        activities=[acts.end_contract_period],
    ):
        for org, expected in ((org_id, "past_due"), (renewed, "unchanged")):
            result = await client.execute_workflow(
                ContractPeriodWorkflow.run,
                ContractPeriod(org, end.isoformat()),
                id=f"billing-contract-{org}-{int(end.timestamp() * 1000)}",
                task_queue=queue,
            )
            assert result == expected
    assert await acts.end_contract_period(ContractPeriod(org_id, end.isoformat())) == "unchanged"
    [sub] = await in_org(pool, org_id, "select status from subscriptions")
    assert sub["status"] == "past_due"
    audit = await in_org(pool, org_id, "select action from audit_log")
    assert [a["action"] for a in audit] == ["billing.contract.past_due"]
    [sub] = await in_org(pool, renewed, "select status from subscriptions")
    assert sub["status"] == "active"


DAYS = timedelta(days=30)
