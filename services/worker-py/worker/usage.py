"""Usage reporting to the payment provider's meters (docs/billing.md "Usage-based").

UsageReportWorkflow (Temporal Schedule, every 15 minutes) runs one `report_org_usage` activity
per organization, each with its own retries, so one failing org never holds up the others. An
org's progress is `subscriptions.usage_reported_until`: each closed hour after it is aggregated
(one event per meter and hour, identifier `<meter>:<org>:<hour>`, so the provider deduplicates a
resend) and the mark moves after every hour. Hours older than the provider accepts are skipped
with a warning, so an org that failed for long never stays stuck. No usage ledger of our own:
the provider rates and invoices.
"""

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Protocol

import asyncpg
import httpx2
from temporalio import activity

from worker.billing import Plans
from worker.flags import is_enabled

log = logging.getLogger(__name__)

HOUR = timedelta(hours=1)
SETTLE = timedelta(minutes=5)  # an hour is reported once it closed this long ago
MAX_AGE = timedelta(days=34)  # Stripe takes meter events up to 35 days old
HOURS_PER_RUN = 72  # catching up after an outage is spread over runs
_SUB = (
    "select plan_id, status, currency, customer_id, provider, current_period_start,"
    " current_period_end, usage_reported_until from subscriptions"
)


class Meters(Protocol):
    """A provider's usage meters (Stripe: StripeMeters); the API has the rest of the adapter."""

    async def report_usage(
        self, customer_id: str, meter: str, value: int, identifier: str, at: datetime
    ) -> None: ...


class StripeMeters:
    """Stripe Meters (billing/meter_events, API >= 2025-03-31.basil). Stripe allows one
    concurrent event per customer and meter, so the caller sends one org's events in sequence."""

    def __init__(self, http: httpx2.AsyncClient, secret_key: str, api_url: str | None) -> None:
        self.http, self.key = http, secret_key
        self.url = f"{(api_url or 'https://api.stripe.com').rstrip('/')}/v1/billing/meter_events"

    async def report_usage(
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


@dataclass(frozen=True)
class _Event:
    meter: str
    value: int
    identifier: str


class UsageActivities:
    def __init__(self, pool: asyncpg.Pool, plans: Plans, meters: dict[str, Meters]) -> None:
        self.pool, self.plans, self.meters = pool, plans, meters  # provider id -> meters

    @activity.defn(name="usage_orgs")
    async def usage_orgs(self) -> list[str]:
        # ponytail: every org, one activity each per run; past ~10k orgs batch them into child
        # workflows (workflow history limit).
        return [r["id"] for r in await self.pool.fetch("select id from organization")]

    @activity.defn(name="report_org_usage")
    async def report_org_usage(self, org_id: str) -> int:
        """Reports the org's closed hours since its mark; returns the events sent. Safe to retry
        or re-run: identifiers are per meter and hour, the mark moves only after an hour."""
        # One short transaction per step: no connection is held over provider calls.
        sub = await _in_org(self.pool, org_id, lambda c: c.fetchrow(_SUB))
        if sub is None or not sub["customer_id"] or sub["provider"] not in self.meters:
            return 0
        if not await is_enabled("billing-usage", user_id=org_id, org_id=org_id):
            return 0
        if not any(self._meters(sub, t) for t in (sub["current_period_start"], datetime.now(UTC))):
            return 0  # the plan meters nothing
        meters = self.meters[sub["provider"]]
        now = datetime.now(UTC)
        end = _hour(now - SETTLE)
        start = sub["usage_reported_until"] or _hour(sub["current_period_start"] or end - HOUR)
        if start < end - MAX_AGE:
            log.warning(
                "org %s: usage before %s is too old for the provider", org_id, end - MAX_AGE
            )
            start = _hour(end - MAX_AGE)
        # A mark inside an hour (a metered price attached then): that hour counts from the mark.
        sent, hour = 0, _hour(start)
        while hour < end and hour < start + HOURS_PER_RUN * HOUR:
            since = max(hour, start)
            events = await _in_org(
                self.pool, org_id, lambda c, h=hour, f=since: self._hour(c, org_id, sub, h, f)
            )
            for e in events:  # in sequence: Stripe takes one event per customer and meter
                await meters.report_usage(sub["customer_id"], e.meter, e.value, e.identifier, hour)
            hour += HOUR
            await _in_org(
                self.pool,
                org_id,
                lambda c, h=hour: c.execute(
                    "update subscriptions set usage_reported_until = $1", h
                ),
            )
            sent += len(events)
        return sent

    def _meters(self, sub: Any, at: datetime | None) -> set[str]:
        """Meters of the plan in effect at `at`, in the subscription's currency."""
        plan = self.plans.at(sub, at or datetime.now(UTC))
        prices = plan.prices.get(sub["currency"], [])
        return {p.meter for p in prices if p.model == "metered" and p.meter}

    async def _hour(
        self, conn: Any, org_id: str, sub: Any, hour: datetime, since: datetime
    ) -> list[_Event]:
        """One event per metered meter of the plan in effect during `hour`, values summed from
        `since` (the hour's start, or the mark inside it)."""
        plan = self.plans.at(sub, hour)
        meters = {
            p.meter
            for p in plan.prices.get(sub["currency"], [])
            if p.model == "metered" and p.meter
        }
        values: dict[str, int] = {}
        if meters & {"llm_cost_micros", "llm_tokens"}:
            # Index range scan on ai_calls (org_id, created_at), like the spend limit.
            rows = await conn.fetch(
                "select cost_currency, sum(cost) as cost, sum(total_tokens) as tokens"
                " from ai_calls where org_id = $1 and created_at >= $2 and created_at < $3"
                " and status = 'ok' and provider not like 'byo:%' group by cost_currency",
                org_id,
                since,
                hour + HOUR,
            )
            for r in rows:
                values["llm_tokens"] = values.get("llm_tokens", 0) + int(r["tokens"] or 0)
                if r["cost_currency"] == sub["currency"]:  # one currency per meter, never mixed
                    micros = (r["cost"] or Decimal(0)) * 1_000_000
                    values["llm_cost_micros"] = int(micros.quantize(Decimal(1), ROUND_HALF_UP))
                elif r["cost_currency"]:
                    log.warning(
                        "org %s: LLM cost in %s is not billed on a %s subscription",
                        org_id,
                        r["cost_currency"],
                        sub["currency"],
                    )
        # Hourly counters cannot be split: a partial first hour leaves its API calls unbilled
        # rather than bill requests from before the metered price.
        if "api_calls" in meters and since == hour:
            values["api_calls"] = int(
                await conn.fetchval(
                    "select coalesce(sum(count), 0) from usage_counters"
                    " where meter = 'api_calls' and hour = $1",
                    hour,
                )
            )
        stamp = f"{org_id}:{hour:%Y%m%dT%H}"
        return [
            _Event(m, v, f"{m}:{stamp}")
            for m, v in sorted(values.items())
            if m in meters and v > 0  # Stripe takes positive integers only
        ]


def _hour(t: datetime) -> datetime:
    return t.replace(minute=0, second=0, microsecond=0)


async def _in_org[T](pool: asyncpg.Pool, org_id: str, fn: Callable[[Any], Awaitable[T]]) -> T:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await fn(conn)
