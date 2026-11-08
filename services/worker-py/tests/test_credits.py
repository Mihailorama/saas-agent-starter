"""Prepaid credit packs (worker/credits.py) against the compose stack and stripe-mock. Plans: the
API's test fixture (`prepaid`: metered llm_cost_micros + a 10.00 USD pack, expiring in 365 days)."""

import os
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import asyncpg
import httpx2
import pytest
from temporalio import activity
from temporalio.client import Client, WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker

from tests.conftest import new_org
from tests.test_billing import FIXTURE_PLANS, call, fake, in_org, spend, subscribe
from worker import credits as credit_module
from worker import settings
from worker.ai import AllowedModel, Gateway
from worker.ai import Price as ModelPrice
from worker.billing import BillingActivities, BillingEvent, SpendLimitExceeded, load_plans
from worker.credits import CreditActivities, StripeCredits, balance_cache
from worker.s3 import S3
from worker.workflows import BillingEventWorkflow, CrmSyncWorkflow

PLANS = load_plans(FIXTURE_PLANS)


class FakeCredits:
    def __init__(self, balance: int = 0, fail: bool = False) -> None:
        self.left, self.fail = balance, fail
        self.grants: list[tuple[str, str, int, datetime | None, str]] = []

    async def credit_balance(self, customer_id: str, currency: str) -> int:
        if self.fail:
            raise RuntimeError("Stripe credit balance failed: 503 None")
        return self.left

    async def grant_credits(
        self, customer_id: str, currency: str, amount: int, expires: datetime | None, key: str
    ) -> None:
        if self.fail:
            raise RuntimeError("Stripe credit grant failed: 503 None")
        self.grants.append((customer_id, currency, amount, expires, key))


def purchase(org: str) -> BillingEvent:
    return BillingEvent(
        provider="stripe",
        contour="en",
        eventId=f"cs_{uuid.uuid4().hex}",
        type="credits.purchased",
        orgId=org,
        occurredAt=datetime.now(UTC).isoformat(),
        planId="prepaid",
        currency="USD",
        customerId="cus_1",
    )


async def actions(pool: asyncpg.Pool, org: str) -> list[str]:
    rows = await in_org(pool, org, "select action from audit_log order by action")
    return [r["action"] for r in rows]


@activity.defn(name="crm_sync")
async def crm_noop(_: Any) -> None:
    return None


async def test_a_paid_pack_is_granted_once_at_the_plans_pack_value(pool: asyncpg.Pool) -> None:
    stripe = FakeCredits()
    grants = CreditActivities(pool, PLANS, {"stripe": stripe})
    org = await new_org(pool)
    await subscribe(pool, org, plan_id="prepaid", customer_id="cus_1")
    e = purchase(org)
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    queue = f"test-{uuid.uuid4()}"
    async with Worker(
        client,
        task_queue=queue,
        workflows=[BillingEventWorkflow, CrmSyncWorkflow],
        activities=[
            BillingActivities(pool, PLANS).apply_billing_event,
            grants.grant_credits,
            crm_noop,
        ],
    ):
        await client.execute_workflow(
            BillingEventWorkflow.run, e, id=f"billing-stripe-{e.eventId}", task_queue=queue
        )
    expires = datetime.fromisoformat(e.occurredAt) + timedelta(days=365)
    assert stripe.grants == [("cus_1", "USD", 1000, expires, f"credits-{e.eventId}")]
    assert not await grants.grant_credits(e)  # replayed: the audit trail says it is done
    assert len(stripe.grants) == 1
    assert await actions(pool, org) == ["billing.credits.granted", "billing.credits.purchased"]


async def test_a_paid_pack_that_cannot_be_granted_fails_loudly(pool: asyncpg.Pool) -> None:
    org = await new_org(pool)
    grants = CreditActivities(pool, PLANS, {})  # no provider key here
    with pytest.raises(ApplicationError, match="paid but cannot be granted") as err:
        await grants.grant_credits(purchase(org))
    assert err.value.non_retryable
    # In the workflow, any final failure (this one, the last attempt, a timeout) is recorded.
    e = purchase(org)
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    queue = f"test-{uuid.uuid4()}"
    async with Worker(
        client,
        task_queue=queue,
        workflows=[BillingEventWorkflow, CrmSyncWorkflow],
        activities=[
            BillingActivities(pool, PLANS).apply_billing_event,
            grants.grant_credits,
            grants.record_grant_failure,
            crm_noop,
        ],
    ):
        with pytest.raises(WorkflowFailureError):
            await client.execute_workflow(
                BillingEventWorkflow.run, e, id=f"billing-stripe-{e.eventId}", task_queue=queue
            )
    rows = await in_org(
        pool, org, "select target from audit_log where action = 'billing.credits.grant_failed'"
    )
    assert [r["target"] for r in rows] == [f"stripe:{e.eventId}"]


async def test_calls_stop_when_the_balance_less_this_periods_spend_is_used_up(
    pool: asyncpg.Pool, s3: S3, monkeypatch: pytest.MonkeyPatch
) -> None:
    stripe = FakeCredits(balance=1500)  # 15.00 USD of credit, not yet drawn by an invoice
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
        credits={"stripe": stripe},
    )
    org = await new_org(pool)
    await subscribe(pool, org, plan_id="prepaid", customer_id="cus_1")
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset({"billing-credits"}))
    await spend(pool, org, "10")
    await call(gateway, org)  # 15 - 10 left
    await spend(pool, org, "5")
    with pytest.raises(SpendLimitExceeded, match="prepaid credit is used up"):
        await call(gateway, org)
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset[str]())
    await call(gateway, org)  # flag off: no balance check

    # The provider is down: the last known balance (within STALE), else the call goes ahead.
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset({"billing-credits"}))
    stripe.fail = True
    read_at, value = balance_cache[org]
    balance_cache[org] = (read_at - credit_module.FRESH - 1, value)
    with pytest.raises(SpendLimitExceeded):
        await call(gateway, org)
    balance_cache.pop(org)
    await call(gateway, org)


async def test_stripe_credit_grants_against_stripe_mock() -> None:
    url = os.environ.get("STRIPE_API_URL", "http://localhost:12111")
    async with httpx2.AsyncClient(timeout=10) as http:
        stripe = StripeCredits(http, "sk_test_123", url)
        assert await stripe.credit_balance("cus_1", "USD") == 0  # fixture currency is fake
        await stripe.grant_credits("cus_1", "USD", 1000, datetime.now(UTC) + timedelta(days=1), "k")
