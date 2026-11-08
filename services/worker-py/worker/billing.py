"""Billing in the worker (docs/billing.md, docs/adr/0019-billing.md).

- `Plans`: config/plans.json, the same file the API reads (apps/api/src/billing/plans.ts).
- `ensure_org_active`: refuses work of an org an operator suspended (activities, the gateway).
- `check_llm_budget`: the LLM spend limit, called by `Gateway.call_llm` before a priced call.
- `check_llm_usage`: the calls/tokens limit, called before a call of an unmetered model (CLI
  subscriptions, self-hosted), which has no cost to limit.
- `BillingActivities.apply_billing_event`: writes a normalized provider event (from the API's
  webhook route, via BillingEventWorkflow) to `subscriptions`. Idempotent: older events never
  overwrite newer state, and audit rows are written once per event.
- `BillingActivities.end_contract_period`: a manual contract's period ran out
  (ContractPeriodWorkflow).
"""

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import asyncpg
from asyncpg.pool import PoolConnectionProxy
from opentelemetry import metrics
from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker.flags import is_enabled

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
usage_blocked = meter.create_counter(
    "billing.llm_usage_blocked",
    description="Unmetered AI calls refused because the calls/tokens limit was reached",
)

WARN_RATIO = Decimal("0.8")  # same as LLM_WARN_RATIO in apps/api/src/routes/billing.ts
PAID = frozenset({"active", "past_due"})


@dataclass(frozen=True)
class Price:
    """One priced component (`model`: flat, per_seat, metered, credits, contract). Rating stays
    in the provider; the worker needs the model and the meter."""

    model: str
    amount: str | None = None
    interval: str | None = None
    meter: str | None = None
    expires_days: int | None = None  # credits: a granted pack expires after this many days


def _prices(raw: dict[str, Any] | list[dict[str, Any]]) -> list[Price]:
    """One component or an array; a component without `model` is a (pre-model) flat price."""
    parts = raw if isinstance(raw, list) else [raw]
    return [
        Price(
            c.get("model", "flat"),
            c.get("amount") or c.get("pack", {}).get("amount"),  # credits: the pack's price
            c.get("interval"),
            c.get("meter"),
            c.get("expiresDays"),
        )
        for c in parts
    ]


@dataclass(frozen=True)
class Plan:
    name: str
    llm_spend_monthly: dict[str, Decimal]
    llm_spend_max: dict[str, Decimal]
    llm_limit_raise: bool
    prices: dict[str, list[Price]]
    # Unmetered models (subscriptions, self-hosted): {"calls": n, "tokens": n}, either optional.
    llm_usage_monthly: dict[str, int] = field(default_factory=dict[str, int])
    byo_llm: bool = False  # organizations may bring their own provider (ai_providers)


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

    def at(self, sub: Any, at: datetime) -> Plan:
        """The plan that was in effect at `at` (usage reporting, hour by hour): as `effective`,
        but a canceled subscription still counts until the end of its last period."""
        end: datetime | None = sub["current_period_end"] if sub is not None else None
        if sub is not None and sub["status"] == "canceled" and end is not None and at < end:
            return self.plans.get(sub["plan_id"], self.plans[self.default])
        return self.effective(sub, at)[1]

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
            prices={c: _prices(x) for c, x in p["prices"].items()},
            llm_usage_monthly={
                k: int(v) for k, v in p["limits"].get("llmUsageMonthly", {}).items()
            },
            byo_llm=bool(p["features"].get("byoLlm", False)),
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
    # Pay as you go (a metered LLM price, docs/billing.md "Usage-based"): the plan's limit is
    # only a warning; `cap` is the hard stop: the org's own raised cap, else llmSpendMax.
    payg: bool = False
    cap: Decimal | None = None


LLM_METERS = frozenset({"llm_cost_micros", "llm_tokens"})


class SpendLimitExceeded(ApplicationError):
    def __init__(self, message: str, type: str = "SpendLimitExceeded") -> None:
        super().__init__(message, type=type, non_retryable=True)


class UsageLimitExceeded(SpendLimitExceeded):
    """The calls/tokens limit for unmetered models; callers handle it like the spend limit."""

    def __init__(self, message: str) -> None:
        super().__init__(message, type="UsageLimitExceeded")


_SUBSCRIPTION = (
    "select plan_id, status, currency, current_period_start, current_period_end,"
    " llm_spend_limits from subscriptions"
)


async def byo_allowed(conn: PoolConnectionProxy, plans: Plans) -> bool:
    """Whether the org's plan in force includes BYO providers (`conn` scoped to the org)."""
    return plans.effective(await conn.fetchrow(_SUBSCRIPTION), datetime.now(UTC))[1].byo_llm


class OrgSuspended(ApplicationError):
    """The organization is suspended by an operator (docs/admin.md): its work stops."""

    def __init__(self, org_id: str) -> None:
        super().__init__(
            f"organization {org_id} is suspended", type="OrgSuspended", non_retryable=True
        )


async def ensure_org_active(conn: "asyncpg.Connection | PoolConnectionProxy", org_id: str) -> None:
    """Raises OrgSuspended when an operator suspended the org. Checked inside each activity (not
    only when a workflow starts), so already-queued work stops too. `organization` has no RLS."""
    if await conn.fetchval(
        "select 1 from organization where id = $1 and suspended_at is not null", org_id
    ):
        raise OrgSuspended(org_id)


async def llm_budget(
    conn: PoolConnectionProxy, plans: Plans, org_id: str, currency: str, now: datetime
) -> Budget:
    """Spend vs. limit; `conn` must be in a transaction with app.org_id set (RLS)."""
    sub = await conn.fetchrow(_SUBSCRIPTION)
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
    own = None
    if plan.llm_limit_raise and currency in raised and currency in plan.llm_spend_max:
        limit = own = min(Decimal(str(raised[currency])), plan.llm_spend_max[currency])
    prices = plan.prices.get(sub["currency"], []) if sub and plans.paid(sub, now) else []
    payg = any(p.model == "metered" and p.meter in LLM_METERS for p in prices)
    cap = own if own is not None else plan.llm_spend_max.get(currency)
    return Budget(plan_id, spent, limit, payg, cap)


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
    hard: Decimal | None = budget.limit
    if budget.payg and await is_enabled("billing-usage", user_id=org_id, org_id=org_id):
        hard = budget.cap  # usage is billed: stop at the org's own cap, else llmSpendMax
        if budget.spent >= budget.limit and (hard is None or budget.spent < hard):
            log.warning("org %s: LLM spend over the plan's limit (pay as you go)", org_id)
            return
    if hard is not None and budget.spent >= hard:
        blocked_calls.add(1, labels)
        log.warning("org %s: LLM spend limit reached, call refused", org_id)
        raise SpendLimitExceeded(
            "LLM spend limit for this billing period is reached; raise it on the billing page"
            " or upgrade the plan"
        )
    if ratio >= WARN_RATIO:
        log.warning("org %s: LLM spend at %d%% of the limit", org_id, int(ratio * 100))


async def check_llm_usage(
    pool: asyncpg.Pool, plans: Plans, org_id: str, models: Sequence[str]
) -> None:
    """Raises UsageLimitExceeded once the org's successful calls of unmetered models
    (`models`: provider/model) or their tokens reach the plan's llmUsageMonthly.

    ponytail: check-then-act like the spend limit; concurrent calls can overshoot by one each.
    """
    now = datetime.now(UTC)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        sub = await conn.fetchrow(_SUBSCRIPTION)
        plan_id, plan = plans.effective(sub, now)
        if not plan.llm_usage_monthly:
            return
        start, end = billing_period(plans, sub, now)
        # Same index range scan as the spend sum, then a filter on the few unmetered models.
        used = await conn.fetchrow(
            "select count(*) as calls, coalesce(sum(total_tokens), 0) as tokens from ai_calls"
            " where org_id = $1 and created_at >= $2 and created_at < $3 and status = 'ok'"
            " and provider || '/' || request_model = any($4::text[])",
            org_id,
            start,
            end,
            list(models),
        )
    assert used is not None
    for unit in ("calls", "tokens"):
        limit = plan.llm_usage_monthly.get(unit)
        if limit is not None and used[unit] >= limit:
            usage_blocked.add(1, {"plan": plan_id, "unit": unit})
            log.warning("org %s: LLM usage limit (%s) reached, call refused", org_id, unit)
            raise UsageLimitExceeded(
                f"LLM usage limit ({unit}) for this billing period is reached; upgrade the plan"
            )


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
    periodStart: str | None = None
    periodEnd: str | None = None
    cancelAtPeriodEnd: bool | None = None
    seats: int | None = None
    contractRef: str | None = None


@dataclass(frozen=True)
class ContractPeriod:
    """Contract with apps/api/src/temporal.ts (ContractPeriod)."""

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


async def audit_once(conn: PoolConnectionProxy, org_id: str, action: str, target: str) -> None:
    await conn.execute(
        "insert into audit_log (org_id, actor_id, action, target)"
        " select $1, 'billing', $2, $3"
        " where not exists (select 1 from audit_log where action = $2 and target = $3)",
        org_id,
        action,
        target,
    )


class BillingActivities:
    def __init__(self, pool: asyncpg.Pool, plans: Plans) -> None:
        self.pool, self.plans = pool, plans

    @activity.defn(name="apply_billing_event")
    async def apply_billing_event(self, e: BillingEvent) -> bool:
        """Applies the event; False if it was older than the state already stored."""
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", e.orgId)
            if e.type not in STATUS:  # payment.succeeded / payment.failed: trail only
                await audit_once(conn, e.orgId, f"billing.{e.type}", f"{e.provider}:{e.eventId}")
                return True
            occurred = datetime.fromisoformat(e.occurredAt)
            last = await conn.fetchval("select last_event_at from subscriptions for update")
            if last is not None and last > occurred:
                activity.logger.info("billing event %s is older than the stored state", e.eventId)
                return False
            await conn.execute(
                """
                insert into subscriptions as s (org_id, plan_id, status, contour, provider,
                  currency, customer_id, provider_subscription_id,
                  current_period_start, current_period_end, cancel_at_period_end,
                  last_event_at, updated_at, seats, contract_ref)
                values ($1, coalesce($2, $13), $3, $4, $5, coalesce($6, ''), $7, $8, $9, $10,
                  coalesce($11, false), $12, now(), $14, $15)
                on conflict (org_id) do update set
                  plan_id = coalesce($2, s.plan_id), status = $3, contour = $4, provider = $5,
                  currency = coalesce($6, s.currency),
                  customer_id = coalesce($7, s.customer_id),
                  provider_subscription_id = coalesce($8, s.provider_subscription_id),
                  current_period_start = coalesce($9, s.current_period_start),
                  current_period_end = coalesce($10, s.current_period_end),
                  cancel_at_period_end = coalesce($11, s.cancel_at_period_end),
                  last_event_at = $12, updated_at = now(), seats = coalesce($14, s.seats),
                  contract_ref = coalesce($15, s.contract_ref)
                """,
                e.orgId,
                e.planId,
                STATUS[e.type],
                e.contour,
                e.provider,
                e.currency,
                e.customerId,
                e.subscriptionId,
                _ts(e.periodStart),
                _ts(e.periodEnd),
                e.cancelAtPeriodEnd,
                occurred,
                self.plans.default,
                e.seats,
                e.contractRef,
            )
            await audit_once(conn, e.orgId, f"billing.{e.type}", f"{e.provider}:{e.eventId}")
        activity.logger.info("billing event %s (%s) applied for org %s", e.eventId, e.type, e.orgId)
        return True

    @activity.defn(name="end_contract_period")
    async def end_contract_period(self, p: ContractPeriod) -> str:
        """A manual contract reached its period end: `past_due` (the plan holds for
        pastDueGraceDays), or `canceled` if it was set to end. A no-op once an operator moved the
        period (a renewal) or the org changed provider; safe to retry."""
        end = datetime.fromisoformat(p.periodEnd)
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", p.orgId)
            status: str | None = await conn.fetchval(
                "update subscriptions set status = case when cancel_at_period_end"
                " then 'canceled' else 'past_due' end, last_event_at = now(), updated_at = now()"
                " where provider = 'manual' and status = 'active' and current_period_end = $1"
                " returning status",
                end,
            )
            if status is not None:
                await audit_once(
                    conn, p.orgId, f"billing.contract.{status}", f"manual:{p.periodEnd}"
                )
        activity.logger.info("contract period of org %s ended: %s", p.orgId, status or "unchanged")
        return status or "unchanged"
