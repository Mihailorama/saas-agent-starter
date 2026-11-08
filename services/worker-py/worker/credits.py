"""Prepaid credit packs in the payment provider (docs/billing.md "Prepaid credits").

- `CreditActivities.grant_credits`: a paid pack (BillingEventWorkflow, `credits.purchased`)
  becomes one provider credit grant of the plan's pack value. Checked against the audit trail
  first and sent with an idempotency key per payment, so it is granted once. Failures are loud:
  an exception (Sentry, through the worker's error interceptor) and a
  `billing.credits.grant_failed` audit row, never a silently kept payment.
- `check_credit_balance`: before a priced AI call, the provider's balance less this period's
  not yet invoiced spend (Stripe applies credit only when it finalizes the invoice). No local
  ledger: the balance is the provider's.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Protocol

import asyncpg
import httpx2
from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker.billing import (
    BillingEvent,
    Plans,
    SpendLimitExceeded,
    audit_once,
    from_minor,
    llm_budget,
    to_minor,
)
from worker.flags import is_enabled

log = logging.getLogger(__name__)

GRANT_ATTEMPTS = 20  # with backoff up to 5 minutes: about 1.5 hours, inside Stripe's 24-hour key
FRESH, STALE = 30.0, 600.0  # seconds a balance is reused; and used while the provider is down
balance_cache: dict[str, tuple[float, int]] = {}  # org -> (read at, minor units)


class Credits(Protocol):
    """A provider's prepaid credit (Stripe: StripeCredits): `creditBalance` and `grantCredits`
    of the provider surface; the API has the rest of the adapter."""

    async def credit_balance(self, customer_id: str, currency: str) -> int: ...

    async def grant_credits(
        self, customer_id: str, currency: str, amount: int, expires: datetime | None, key: str
    ) -> None: ...


class StripeCredits:
    """Stripe credit grants (billing/credit_grants), which apply to metered prices only."""

    def __init__(self, http: httpx2.AsyncClient, secret_key: str, api_url: str | None) -> None:
        self.http, self.key = http, secret_key
        self.base = f"{(api_url or 'https://api.stripe.com').rstrip('/')}/v1/billing"

    async def credit_balance(self, customer_id: str, currency: str) -> int:
        res = await self.http.get(
            f"{self.base}/credit_balance_summary",
            auth=(self.key, ""),
            params={
                "customer": customer_id,
                "filter[type]": "applicability_scope",
                "filter[applicability_scope][price_type]": "metered",
            },
        )
        _raise(res, "credit balance")
        return sum(
            int(m["value"])
            for b in res.json()["balances"]
            if (m := b["available_balance"].get("monetary"))
            and str(m["currency"]).upper() == currency
        )

    async def grant_credits(
        self, customer_id: str, currency: str, amount: int, expires: datetime | None, key: str
    ) -> None:
        data = {
            "customer": customer_id,
            "name": "Prepaid credit pack",
            "category": "paid",
            "amount[type]": "monetary",
            "amount[monetary][currency]": currency.lower(),
            "amount[monetary][value]": str(amount),
            "applicability_config[scope][price_type]": "metered",
        }
        if expires:
            data["expires_at"] = str(int(expires.timestamp()))
        res = await self.http.post(
            f"{self.base}/credit_grants",
            auth=(self.key, ""),
            data=data,
            headers={"Idempotency-Key": key},
        )
        _raise(res, "credit grant")


def _raise(res: httpx2.Response, what: str) -> None:
    if res.is_error:  # status and Stripe's error code only: bodies can echo request fields
        code = res.json().get("error", {}).get("code") if res.content else None
        raise RuntimeError(f"Stripe {what} failed: {res.status_code} {code}")


_SUB = (
    "select plan_id, status, currency, customer_id, provider, current_period_start,"
    " current_period_end, llm_spend_limits from subscriptions"
)


async def check_credit_balance(
    pool: asyncpg.Pool, plans: Plans, credits: dict[str, Credits], org_id: str
) -> None:
    """Raises SpendLimitExceeded once the org's prepaid credit is used up (flag
    billing-credits), on plans that sell credit packs.

    ponytail: the balance is read at most every FRESH seconds per org and process, so a burst of
    calls can overdraw by those calls; the provider bills an overdraft as usage.
    """
    now = datetime.now(UTC)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        sub = await conn.fetchrow(_SUB)
        _, plan = plans.effective(sub, now)
        if sub is None or not sub["customer_id"] or sub["provider"] not in credits:
            return
        currency: str = sub["currency"]
        if not any(p.model == "credits" for p in plan.prices.get(currency, [])):
            return
        # The same sum as the spend limit: this period's AI cost in the subscription's currency.
        spent = (await llm_budget(conn, plans, org_id, currency, now)).spent
    if not await is_enabled("billing-credits", user_id=org_id, org_id=org_id):
        return
    balance = await _balance(credits[sub["provider"]], org_id, sub["customer_id"], currency)
    if balance is None:
        return  # provider down and nothing known yet: usage is billed, do not stop the product
    left = from_minor(balance, currency) - spent
    if left <= 0:
        log.warning("org %s: prepaid credit used up, call refused", org_id)
        raise SpendLimitExceeded("prepaid credit is used up; buy a credit pack on the billing page")


async def _balance(adapter: Credits, org_id: str, customer: str, currency: str) -> int | None:
    t = asyncio.get_running_loop().time()
    cached = balance_cache.get(org_id)
    if cached and t - cached[0] < FRESH:
        return cached[1]
    try:
        value = await adapter.credit_balance(customer, currency)
    except Exception:
        log.warning("org %s: credit balance unavailable, using the last known", org_id)
        return cached[1] if cached and t - cached[0] < STALE else None
    balance_cache[org_id] = (t, value)
    return value


class CreditActivities:
    def __init__(self, pool: asyncpg.Pool, plans: Plans, credits: dict[str, Credits]) -> None:
        self.pool, self.plans, self.credits = pool, plans, credits  # provider id -> adapter

    @activity.defn(name="grant_credits")
    async def grant_credits(self, e: BillingEvent) -> bool:
        """A paid pack -> one grant of the plan's pack value. False if it was granted already."""
        target = f"{e.provider}:{e.eventId}"
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", e.orgId)
            done = await conn.fetchval(
                "select 1 from audit_log where action = 'billing.credits.granted' and target = $1",
                target,
            )
        if done:
            return False
        plan = self.plans.plans.get(e.planId or "")
        currency = e.currency or ""
        pack = next(
            (p for p in (plan.prices.get(currency, []) if plan else []) if p.model == "credits"),
            None,
        )
        adapter = self.credits.get(e.provider)
        if pack is None or pack.amount is None or adapter is None or not e.customerId:
            await self._failed(e, target)
            raise ApplicationError(
                f"credit pack {e.eventId} was paid but cannot be granted here (plan, currency,"
                " provider key or customer missing): grant it by hand",
                type="CreditGrantFailed",
                non_retryable=True,
            )
        days = pack.expires_days
        expires = datetime.fromisoformat(e.occurredAt) + timedelta(days=days) if days else None
        try:
            await adapter.grant_credits(
                e.customerId,
                currency,
                to_minor(pack.amount, currency),
                expires,
                f"credits-{e.eventId}",
            )
        except Exception:
            if activity.info().attempt >= GRANT_ATTEMPTS:
                await self._failed(e, target)
            raise
        balance_cache.pop(e.orgId, None)  # the next call reads the new balance
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", e.orgId)
            await audit_once(conn, e.orgId, "billing.credits.granted", target)
        return True

    async def _failed(self, e: BillingEvent, target: str) -> None:
        log.error("credit pack %s of org %s paid but not granted", e.eventId, e.orgId)
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", e.orgId)
            await audit_once(conn, e.orgId, "billing.credits.grant_failed", target)
