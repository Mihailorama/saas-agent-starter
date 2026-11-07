"""Billing in the worker (docs/billing.md, docs/adr/0019-billing.md).

- `Plans`: config/plans.json, the same file the API reads (apps/api/src/billing/plans.ts).
- `check_llm_budget`: the LLM spend limit, called by `Gateway.call_llm` before every call.
- `BillingActivities.apply_billing_event`: writes a normalized provider event (from the API's
  webhook route, via BillingEventWorkflow) to `subscriptions`. Idempotent: older events never
  overwrite newer state, and audit rows are written once per event.
- `BillingActivities.charge_renewal`: for providers without their own subscriptions (YooKassa)
  charges the saved payment method at the end of each period (SubscriptionRenewalWorkflow).
"""

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import asyncpg
import httpx2
from asyncpg.pool import PoolConnectionProxy
from opentelemetry import metrics
from temporalio import activity
from temporalio.exceptions import ApplicationError

log = logging.getLogger(__name__)
meter = metrics.get_meter("worker.billing")
# Labelled by plan and cost currency only, never by org (AGENTS.md "Observability").
spend_ratio = meter.create_histogram(
    "billing.llm_spend_ratio",
    description="LLM spend in the billing period / the org's limit, at each AI call",
    explicit_bucket_boundaries_advisory=[0.25, 0.5, 0.8, 0.9, 1.0, 1.5],
)
blocked_calls = meter.create_counter(
    "billing.llm_blocked", description="AI calls refused because the spend limit was reached"
)

WARN_RATIO = Decimal("0.8")  # same as LLM_WARN_RATIO in apps/api/src/routes/billing.ts
PAID = frozenset({"active", "past_due"})
# Providers that do not renew by themselves: the worker charges the saved payment method.
RENEWED_BY_WORKER = frozenset({"yookassa"})
_IDEMPOTENCE_NS = uuid.UUID("5b0e4c1e-2f7a-4c3e-9d55-6a1f0b7c2d10")


@dataclass(frozen=True)
class Price:
    amount: str
    interval: str


@dataclass(frozen=True)
class Plan:
    name: str
    llm_spend_monthly: dict[str, Decimal]
    llm_spend_max: dict[str, Decimal]
    llm_limit_raise: bool
    prices: dict[str, Price]


@dataclass(frozen=True)
class Plans:
    default: str
    plans: dict[str, Plan]
    past_due_grace: timedelta

    def paid(self, sub: asyncpg.Record | None, now: datetime) -> bool:
        """Active, or past_due until the grace period after the paid period ends."""
        if sub is None or sub["status"] not in PAID:
            return False
        end: datetime | None = sub["current_period_end"]
        return sub["status"] == "active" or end is None or now < end + self.past_due_grace

    def effective(self, sub: asyncpg.Record | None, now: datetime) -> tuple[str, Plan]:
        """Plan in force: the subscribed one while paid (or in grace), else the default."""
        plan_id = sub["plan_id"] if sub is not None and self.paid(sub, now) else None
        if plan_id in self.plans:
            return plan_id, self.plans[plan_id]
        return self.default, self.plans[self.default]


def _money(m: dict[str, Any]) -> dict[str, Decimal]:
    return {k: Decimal(str(v)) for k, v in m.items()}


def load_plans(path: Path) -> Plans:
    doc: dict[str, Any] = json.loads(path.read_text())
    plans = {
        plan_id: Plan(
            name=p["name"],
            llm_spend_monthly=_money(p["limits"]["llmSpendMonthly"]),
            llm_spend_max=_money(p["llmSpendMax"]),
            llm_limit_raise=bool(p["features"].get("llmLimitRaise", False)),
            prices={c: Price(x["amount"], x["interval"]) for c, x in p["prices"].items()},
        )
        for plan_id, p in doc["plans"].items()
    }
    if doc["defaultPlan"] not in plans:
        raise ValueError(f"defaultPlan {doc['defaultPlan']!r} is not in {path}")
    return Plans(doc["defaultPlan"], plans, timedelta(days=int(doc["pastDueGraceDays"])))


def billing_period(
    plans: Plans, sub: asyncpg.Record | None, now: datetime
) -> tuple[datetime, datetime]:
    """The paid period while it runs, else the calendar month (UTC). Same as the API's."""
    if sub is not None and plans.paid(sub, now):
        start, end = sub["current_period_start"], sub["current_period_end"]
        if start is not None and end is not None and start <= now < end:
            return start, end
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = (
        start.replace(year=start.year + 1, month=1)
        if start.month == 12
        else start.replace(month=start.month + 1)
    )
    return start, end


@dataclass(frozen=True)
class Budget:
    plan_id: str
    spent: Decimal
    limit: Decimal | None


class SpendLimitExceeded(ApplicationError):
    def __init__(self, message: str) -> None:
        super().__init__(message, type="SpendLimitExceeded", non_retryable=True)


async def llm_budget(
    conn: PoolConnectionProxy, plans: Plans, org_id: str, currency: str, now: datetime
) -> Budget:
    """Spend vs. limit; `conn` must be in a transaction with app.org_id set (RLS)."""
    sub = await conn.fetchrow(
        "select plan_id, status, current_period_start, current_period_end, llm_spend_limits"
        " from subscriptions"
    )
    plan_id, plan = plans.effective(sub, now)
    start, end = billing_period(plans, sub, now)
    # Index range scan on ai_calls (org_id, created_at); tests/test_billing.py checks the plan.
    spent: Decimal = await conn.fetchval(
        "select coalesce(sum(cost), 0) from ai_calls where org_id = $1 and cost_currency = $2"
        " and created_at >= $3 and created_at < $4",
        org_id,
        currency,
        start,
        end,
    )
    limit = plan.llm_spend_monthly.get(currency)
    raised: dict[str, Any] = json.loads(sub["llm_spend_limits"] or "{}") if sub else {}
    if plan.llm_limit_raise and currency in raised and currency in plan.llm_spend_max:
        limit = min(Decimal(str(raised[currency])), plan.llm_spend_max[currency])
    return Budget(plan_id, spent, limit)


async def check_llm_budget(pool: asyncpg.Pool, plans: Plans, org_id: str, currency: str) -> None:
    """Raises SpendLimitExceeded at 100% of the limit; logs a warning from 80%.

    ponytail: concurrent calls of one org can each pass the check and overshoot by their own
    cost; lock the subscription row here if that ever matters.
    """
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        budget = await llm_budget(conn, plans, org_id, currency, datetime.now(UTC))
    if budget.limit is None:
        return  # no limit in this currency for the plan (see the config consistency test)
    labels = {"plan": budget.plan_id, "currency": currency}
    ratio = budget.spent / budget.limit if budget.limit > 0 else Decimal(1)
    spend_ratio.record(float(ratio), labels)
    if budget.spent >= budget.limit:
        blocked_calls.add(1, labels)
        log.warning("org %s: LLM spend limit reached, call refused", org_id)
        raise SpendLimitExceeded(
            "LLM spend limit for this billing period is reached; raise it on the billing page"
            " or upgrade the plan"
        )
    if ratio >= WARN_RATIO:
        log.warning("org %s: LLM spend at %d%% of the limit", org_id, int(ratio * 100))


@dataclass(frozen=True)
class BillingEvent:
    """Contract with apps/api/src/billing/provider.ts (BillingEvent, camelCase JSON)."""

    provider: str
    contour: str
    eventId: str
    type: str
    orgId: str
    occurredAt: str
    planId: str | None = None
    currency: str | None = None
    customerId: str | None = None
    subscriptionId: str | None = None
    paymentMethodId: str | None = None
    periodStart: str | None = None
    periodEnd: str | None = None
    cancelAtPeriodEnd: bool | None = None


@dataclass(frozen=True)
class Renewal:
    orgId: str
    periodEnd: str


STATUS = {
    "subscription.activated": "active",
    "subscription.renewed": "active",
    "subscription.past_due": "past_due",
    "subscription.canceled": "canceled",
}


def _ts(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


async def _audit_once(conn: PoolConnectionProxy, org_id: str, action: str, target: str) -> None:
    await conn.execute(
        "insert into audit_log (org_id, actor_id, action, target)"
        " select $1, 'billing', $2, $3"
        " where not exists (select 1 from audit_log where action = $2 and target = $3)",
        org_id,
        action,
        target,
    )


class YooKassa:
    """The one call the worker makes: an autopayment with the saved payment method.

    https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved
    The Idempotence-Key makes retries safe for 24 hours (yookassa.ru/developers/using-api/
    interaction-format); the result arrives as a notification at the API's webhook.
    """

    def __init__(
        self, shop_id: str, secret_key: str, api_url: str, http: httpx2.AsyncClient | None = None
    ) -> None:
        self.auth, self.api_url = (shop_id, secret_key), api_url.rstrip("/")
        self.http = http or httpx2.AsyncClient(timeout=30)

    async def charge(
        self, body: dict[str, Any], idempotence_key: str
    ) -> str:  # returns the payment status
        res = await self.http.post(
            f"{self.api_url}/payments",
            auth=self.auth,
            headers={"Idempotence-Key": idempotence_key},
            json=body,
        )
        res.raise_for_status()  # 5xx: outcome unknown, the retry with the same key resolves it
        status: str = res.json()["status"]
        return status


class BillingActivities:
    def __init__(self, pool: asyncpg.Pool, plans: Plans, yookassa: YooKassa | None = None) -> None:
        self.pool, self.plans, self.yookassa = pool, plans, yookassa

    @activity.defn(name="apply_billing_event")
    async def apply_billing_event(self, e: BillingEvent) -> bool:
        """Applies the event; False if it was older than the state already stored."""
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", e.orgId)
            if e.type not in STATUS:  # payment.succeeded / payment.failed: trail only
                await _audit_once(conn, e.orgId, f"billing.{e.type}", f"{e.provider}:{e.eventId}")
                return True
            occurred = datetime.fromisoformat(e.occurredAt)
            last = await conn.fetchval("select last_event_at from subscriptions for update")
            if last is not None and last > occurred:
                activity.logger.info("billing event %s is older than the stored state", e.eventId)
                return False
            await conn.execute(
                """
                insert into subscriptions as s (org_id, plan_id, status, contour, provider,
                  currency, customer_id, provider_subscription_id, payment_method_id,
                  current_period_start, current_period_end, cancel_at_period_end,
                  last_event_at, updated_at)
                values ($1, coalesce($2, $14), $3, $4, $5, coalesce($6, ''), $7, $8, $9, $10, $11,
                  coalesce($12, false), $13, now())
                on conflict (org_id) do update set
                  plan_id = coalesce($2, s.plan_id), status = $3, contour = $4, provider = $5,
                  currency = coalesce($6, s.currency),
                  customer_id = coalesce($7, s.customer_id),
                  provider_subscription_id = coalesce($8, s.provider_subscription_id),
                  payment_method_id = coalesce($9, s.payment_method_id),
                  current_period_start = coalesce($10, s.current_period_start),
                  current_period_end = coalesce($11, s.current_period_end),
                  cancel_at_period_end = coalesce($12, s.cancel_at_period_end),
                  last_event_at = $13, updated_at = now()
                """,
                e.orgId,
                e.planId,
                STATUS[e.type],
                e.contour,
                e.provider,
                e.currency,
                e.customerId,
                e.subscriptionId,
                e.paymentMethodId,
                _ts(e.periodStart),
                _ts(e.periodEnd),
                e.cancelAtPeriodEnd,
                occurred,
                self.plans.default,
            )
            await _audit_once(conn, e.orgId, f"billing.{e.type}", f"{e.provider}:{e.eventId}")
        activity.logger.info("billing event %s (%s) applied for org %s", e.eventId, e.type, e.orgId)
        return True

    @activity.defn(name="charge_renewal")
    async def charge_renewal(self, r: Renewal) -> str:
        """Charges the next period, or ends the subscription if it was canceled. Retry-safe."""
        period_end = datetime.fromisoformat(r.periodEnd)
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", r.orgId)
            sub = await conn.fetchrow("select * from subscriptions for update")
            if (
                sub is None
                or sub["provider"] not in RENEWED_BY_WORKER
                or sub["status"] not in PAID
                or sub["current_period_end"] != period_end
            ):
                return "superseded"  # renewed, canceled or replaced since this was scheduled
            ending = "canceled" if sub["cancel_at_period_end"] else None
            if ending is None and not sub["payment_method_id"]:
                ending = "past_due"  # the first payment did not save a method: nothing to charge
            if ending is not None:
                await conn.execute(
                    "update subscriptions"
                    " set status = $1, last_event_at = now(), updated_at = now()",
                    ending,
                )
                await _audit_once(conn, r.orgId, f"billing.subscription.{ending}", r.periodEnd)
                return ending
        if self.yookassa is None:
            raise ApplicationError("YooKassa is not configured in the worker", non_retryable=True)
        plan = self.plans.plans.get(sub["plan_id"], self.plans.plans[self.plans.default])
        amount = plan.prices.get(sub["currency"])
        if amount is None:
            raise ApplicationError(
                f"plan {sub['plan_id']} has no {sub['currency']} price", non_retryable=True
            )
        status = await self.yookassa.charge(
            {
                "amount": {"value": amount.amount, "currency": sub["currency"]},
                "capture": True,
                "payment_method_id": sub["payment_method_id"],
                "description": f"{plan.name} subscription renewal",
                "metadata": {
                    "orgId": r.orgId,
                    "planId": sub["plan_id"],
                    "kind": "renewal",
                    "periodStart": r.periodEnd,
                },
            },
            str(uuid.uuid5(_IDEMPOTENCE_NS, f"{r.orgId}:{r.periodEnd}")),
        )
        activity.logger.info("renewal for org %s: payment %s", r.orgId, status)
        return status
