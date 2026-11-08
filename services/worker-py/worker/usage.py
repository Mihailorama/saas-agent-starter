"""Usage and prepaid credits in the payment provider (docs/billing.md "Usage-based",
"Prepaid credits").

`UsageActivities.report_usage` runs on a Temporal Schedule (UsageReportWorkflow). For each org
whose plan in force has a `metered` price it sends one meter event per `ai_calls` row
(`llm_cost_micros`, `llm_tokens`) and one per closed hour of API-key requests (`api_calls`,
from `usage_counters`). Identifiers are deterministic (`<meter>:<id>`), so a retried or
overlapping run is deduplicated by the provider; the window's end is the workflow's result and
the next run's start, like the privacy retention job. No usage ledger of our own: the provider
rates and invoices.

Credits: `grant_credits` turns a paid pack (BillingEventWorkflow, `credits.purchased`) into a
provider credit grant, once per payment; `check_credit_balance` stops priced AI calls once the
provider's prepaid balance is used up. No local ledger: the balance is the provider's.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Protocol

import asyncpg
import httpx2
from temporalio import activity

from worker.billing import BillingEvent, Plans, SpendLimitExceeded, audit_once
from worker.flags import is_enabled

log = logging.getLogger(__name__)

SETTLE = timedelta(minutes=1)  # rows younger than this may still be committing
FIRST_WINDOW = timedelta(days=1)  # first run ever: report the last day
HOUR = timedelta(hours=1)


class Meters(Protocol):
    """The worker half of a provider with usageReporting (apps/api/src/billing/provider.ts)."""

    async def report(
        self, customer_id: str, meter: str, value: int, identifier: str, at: datetime
    ) -> None: ...


class StripeMeters:
    """Stripe Meters (billing/meter_events, API >= 2025-03-31.basil). Stripe allows one
    concurrent event per customer and meter, so the caller sends one org's events in sequence."""

    def __init__(self, http: httpx2.AsyncClient, secret_key: str, api_url: str | None) -> None:
        self.http, self.key = http, secret_key
        self.url = f"{(api_url or 'https://api.stripe.com').rstrip('/')}/v1/billing/meter_events"

    async def report(
        self, customer_id: str, meter: str, value: int, identifier: str, at: datetime
    ) -> None:
        res = await self.http.post(
            self.url,
            auth=(self.key, ""),
            data={
                "event_name": meter,
                "payload[stripe_customer_id]": customer_id,
                "payload[value]": str(value),
                "identifier": identifier,
                "timestamp": str(int(at.timestamp())),
            },
        )
        if res.status_code == 400 and "duplicate_meter_event" in res.text:
            return  # sent by an earlier, overlapping run
        if res.is_error:  # 409 too_many_concurrent_requests and 5xx: the activity retries
            # Status and Stripe's error code only: the body can echo request fields.
            code = res.json().get("error", {}).get("code") if res.content else None
            raise RuntimeError(f"Stripe meter event failed: {res.status_code} {code}")


class Credits(Protocol):
    """The worker half of a provider with creditBalance (apps/api/src/billing/provider.ts)."""

    async def balance(self, customer_id: str, currency: str) -> int: ...

    async def grant(
        self, customer_id: str, currency: str, amount: int, expires: datetime | None, key: str
    ) -> None: ...


class StripeCredits:
    """Stripe credit grants (billing/credit_grants), which apply to metered prices only."""

    def __init__(self, http: httpx2.AsyncClient, secret_key: str, api_url: str | None) -> None:
        self.http, self.key = http, secret_key
        self.base = f"{(api_url or 'https://api.stripe.com').rstrip('/')}/v1/billing"

    async def balance(self, customer_id: str, currency: str) -> int:
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

    async def grant(
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
        # Stripe keeps idempotency keys for 24 hours; the activity retries well within that.
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


BALANCE_TTL = 30.0  # seconds a balance read is reused by the gateway
balance_cache: dict[str, tuple[float, int]] = {}


async def check_credit_balance(
    pool: asyncpg.Pool, plans: Plans, credits: dict[str, Credits], org_id: str
) -> None:
    """Raises SpendLimitExceeded when the org's plan sells credit packs and the provider's
    prepaid balance is used up (flag billing-credits).

    ponytail: the balance is read at most every BALANCE_TTL seconds per org and process, so a
    burst of calls can overdraw by those calls; the provider bills any overdraft as usage.
    """

    async def read(conn: Any) -> Any:
        return await conn.fetchrow(
            "select plan_id, status, currency, customer_id, provider, current_period_start,"
            " current_period_end from subscriptions"
        )

    sub = await _in_org(pool, org_id, read)
    _, plan = plans.effective(sub, datetime.now(UTC))
    if sub is None or not sub["customer_id"] or sub["provider"] not in credits:
        return
    if not any(p.model == "credits" for p in plan.prices.get(sub["currency"], [])):
        return
    if not await is_enabled("billing-credits", user_id=org_id, org_id=org_id):
        return
    now = asyncio.get_running_loop().time()
    cached = balance_cache.get(org_id)
    if cached is None or now - cached[0] > BALANCE_TTL:
        balance = await credits[sub["provider"]].balance(sub["customer_id"], sub["currency"])
        cached = balance_cache[org_id] = (now, balance)
    if cached[1] <= 0:
        log.warning("org %s: prepaid credit used up, call refused", org_id)
        raise SpendLimitExceeded("prepaid credit is used up; buy a credit pack on the billing page")


@dataclass(frozen=True)
class _Event:
    meter: str
    value: int
    identifier: str
    at: datetime


class UsageActivities:
    def __init__(
        self,
        pool: asyncpg.Pool,
        plans: Plans,
        meters: dict[str, Meters],
        credits: dict[str, Credits] | None = None,
    ) -> None:
        self.pool, self.plans, self.meters = pool, plans, meters  # provider id -> adapter
        self.credits = credits or {}

    @activity.defn(name="grant_credits")
    async def grant_credits(self, e: BillingEvent) -> bool:
        """A paid pack -> one credit grant in the provider (idempotency key per payment), then
        one audit row. False if the provider has no credits adapter here."""
        adapter = self.credits.get(e.provider)
        if adapter is None or not e.customerId or not e.currency or not e.amount:
            activity.logger.warning("credit pack %s cannot be granted here", e.eventId)
            return False
        plan = self.plans.plans.get(e.planId or "")
        pack = next(
            (p for p in (plan.prices.get(e.currency, []) if plan else []) if p.model == "credits"),
            None,
        )
        days = pack.expires_days if pack else None
        expires = datetime.fromisoformat(e.occurredAt) + timedelta(days=days) if days else None
        await adapter.grant(e.customerId, e.currency, e.amount, expires, f"credits-{e.eventId}")
        balance_cache.pop(e.orgId, None)  # the next call reads the new balance

        async def audit(conn: Any) -> None:
            await audit_once(conn, e.orgId, "billing.credits.granted", f"{e.provider}:{e.eventId}")

        await _in_org(self.pool, e.orgId, audit)
        return True

    @activity.defn(name="report_usage")
    async def report_usage(self, since: str | None) -> dict[str, Any]:
        until = datetime.now(UTC) - SETTLE
        start = datetime.fromisoformat(since) if since else until - FIRST_WINDOW
        orgs = events = 0
        # ponytail: every org is visited, one RLS transaction each; fine for thousands of orgs.
        for (org_id,) in await self.pool.fetch("select id from organization"):
            sent = await self._report_org(org_id, start, until)
            orgs, events = orgs + (sent is not None), events + (sent or 0)
        log.info("usage reported: %d events for %d organizations", events, orgs)
        return {"until": until.isoformat(), "orgs": orgs, "events": events}

    async def _report_org(self, org_id: str, start: datetime, until: datetime) -> int | None:
        """Events sent for one org; None if its plan meters nothing or it is not set up."""

        async def read(conn: Any) -> tuple[Any, list[_Event]] | None:
            sub = await conn.fetchrow(
                "select plan_id, status, currency, customer_id, provider, current_period_start,"
                " current_period_end from subscriptions"
            )
            _, plan = self.plans.effective(sub, until)
            if sub is None or not sub["customer_id"] or sub["provider"] not in self.meters:
                return None
            prices = plan.prices.get(sub["currency"], [])
            meters = {p.meter for p in prices if p.model == "metered" and p.meter}
            if not meters:
                return None
            return sub, await _events(conn, meters, org_id, start, until)

        found = await _in_org(self.pool, org_id, read)
        if found is None or not await is_enabled("billing-usage", user_id=org_id, org_id=org_id):
            return None
        sub, todo = found
        meters = self.meters[sub["provider"]]
        for e in todo:  # in sequence: one concurrent event per customer and meter
            await meters.report(sub["customer_id"], e.meter, e.value, e.identifier, e.at)
        return len(todo)


async def _events(
    conn: Any, meters: set[str], org_id: str, start: datetime, until: datetime
) -> list[_Event]:
    out: list[_Event] = []
    if meters & {"llm_cost_micros", "llm_tokens"}:
        # Index range scan on ai_calls (org_id, created_at), like the spend limit.
        for r in await conn.fetch(
            "select id, cost, total_tokens, created_at from ai_calls where org_id = $1"
            " and created_at > $2 and created_at <= $3 and status = 'ok'",
            org_id,
            start,
            until,
        ):
            cost = int((r["cost"] or Decimal(0)) * 1_000_000)  # millionths of the cost currency
            for meter, value in (("llm_cost_micros", cost), ("llm_tokens", r["total_tokens"])):
                if meter in meters and value:  # Stripe takes positive integers only
                    out.append(_Event(meter, value, f"{meter}:{r['id']}", r["created_at"]))
    if "api_calls" in meters:
        # Hours that closed inside the window: reported once, with their final count.
        for r in await conn.fetch(
            "select hour, count from usage_counters where meter = 'api_calls'"
            " and hour + interval '1 hour' > $1 and hour + interval '1 hour' <= $2",
            start,
            until,
        ):
            stamp = r["hour"].strftime("%Y%m%dT%H")
            out.append(
                _Event("api_calls", r["count"], f"api_calls:{org_id}:{stamp}", r["hour"] + HOUR)
            )
    return out


async def _in_org[T](pool: asyncpg.Pool, org_id: str, fn: Callable[[Any], Awaitable[T]]) -> T:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await fn(conn)
