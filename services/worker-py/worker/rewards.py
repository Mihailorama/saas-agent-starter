"""Rewards (docs/growth.md): the activities of RewardWorkflow.

The API starts the workflow on a server-side trigger (apps/api/src/billing/rewards.ts). The worker
waits the rule's `holdDays`, checks the conditions and the per-org cap and reserves the grant
(`reserve`), has the API apply money and coupon rewards through the billing provider (`apply`:
the provider adapters live in the API), then settles the grant in `reward_grants` (`record`).
A reward the provider cannot apply is recorded as `pending_manual` for operators: never dropped.
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import asyncpg
import httpx2
from opentelemetry import metrics
from temporalio import activity
from temporalio.exceptions import ApplicationError

log = logging.getLogger(__name__)
granted = metrics.get_meter("worker.rewards").create_counter(
    "rewards.granted", description="Rewards recorded, by rule and how they were applied"
)


@dataclass(frozen=True)
class RewardRequest:
    """Contract with apps/api/src/temporal.ts (RewardRequest, camelCase JSON)."""

    orgId: str
    ruleId: str
    subject: str
    userId: str | None = None
    holdDays: int = 0


@dataclass(frozen=True)
class Applied:
    """How it was given: `via` is entitlement, balance_credit, coupon or manual."""

    via: str
    reward: dict[str, Any]
    ref: str | None = None


def load_rules(path: Path) -> dict[str, dict[str, Any]]:
    """config/rewards.json by rule id (the API validates its schema, apps/api/test)."""
    return {r["id"]: r for r in json.loads(path.read_text())["rules"]}


def same_domain_blocked(path: Path) -> bool:
    """config/rewards.json `referral.blockSameEmailDomain` (default off)."""
    return bool(json.loads(path.read_text()).get("referral", {}).get("blockSameEmailDomain"))


async def _referral_ok(conn: Any, referrer: str, referred: str, block_domain: bool) -> bool:
    """referral.converted guards: not the org itself; the referred subscription still active
    after the hold (refunds and chargebacks cancel it); optionally no owner email domain shared
    by both orgs. The API refuses a card the referrer also pays with (routes/billing.ts)."""
    if referrer == referred:
        return False
    await conn.execute("select set_config('app.org_id', $1, true)", referred)
    active = await conn.fetchval("select status = 'active' from subscriptions")
    await conn.execute("select set_config('app.org_id', $1, true)", referrer)
    if not active:
        return False
    # ponytail: free-mail domains (gmail.com) match too, so it ships off; add a list if needed.
    return not (
        block_domain
        and await conn.fetchval(
            'select 1 from member m join "user" u on u.id = m.user_id'
            " where m.organization_id = any($1::text[]) and m.role like '%owner%'"
            " group by lower(split_part(u.email, '@', 2))"
            " having count(distinct m.organization_id) > 1 limit 1",
            [referrer, referred],
        )
    )


class RewardActivities:
    def __init__(
        self,
        pool: asyncpg.Pool,
        rules: dict[str, dict[str, Any]],
        http: httpx2.AsyncClient,
        api_url: str,
        api_token: str,
        block_same_domain: bool = False,
    ) -> None:
        self.pool, self.rules, self.http = pool, rules, http
        self.block_same_domain = block_same_domain
        self.api_url, self.api_token = api_url.rstrip("/"), api_token

    @activity.defn(name="reward_reserve")
    async def reserve(self, r: RewardRequest) -> dict[str, Any] | None:
        """Reserves the grant if the conditions hold now, else None: the rule's reward.

        One transaction under an advisory lock on (org, rule), so concurrent workflows of one org
        never pass the cap together. A subject gets a rule once, ever (also after Temporal forgot
        the workflow id); a retry of this same workflow finds its own reservation.
        """
        rule = self.rules.get(r.ruleId)
        if rule is None:
            log.warning("reward rule %s is no longer configured", r.ruleId)
            return None
        key = activity.info().workflow_id
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", r.orgId)
            await conn.execute(
                "select pg_advisory_xact_lock(hashtext($1))", f"reward:{r.orgId}:{r.ruleId}"
            )
            mine = await conn.fetchrow(
                "select status, idempotency_key from reward_grants where rule_id = $1"
                " and subject = $2",
                r.ruleId,
                r.subject,
            )
            if mine is not None:
                own = mine["status"] == "reserved" and mine["idempotency_key"] == key
                return rule["reward"] if own else None
            ok = await self._conditions(conn, r, rule)
            if ok:
                count: int = await conn.fetchval(
                    "select count(*) from reward_grants where rule_id = $1", r.ruleId
                )
                ok = count < rule["capPerOrg"]
            if ok:
                await conn.execute(
                    "insert into reward_grants (org_id, rule_id, subject, status, reward,"
                    " idempotency_key) values ($1, $2, $3, 'reserved', $4::jsonb, $5)",
                    r.orgId,
                    r.ruleId,
                    r.subject,
                    json.dumps(rule["reward"]),
                    key,
                )
        if not ok:
            log.info("reward %s for org %s: not eligible", r.ruleId, r.orgId)
            return None
        return rule["reward"]

    async def _conditions(self, conn: Any, r: RewardRequest, rule: dict[str, Any]) -> bool:
        org = await conn.fetchrow(
            "select metadata, suspended_at from organization where id = $1", r.orgId
        )
        if org is None or org["suspended_at"] is not None:
            return False
        if rule["trigger"] == "invitation.accepted":
            # Abuse guard: a verified account, still a member after the hold, and its first
            # accepted invitation anywhere: one account cannot be re-invited by org after org.
            return bool(
                await conn.fetchval(
                    'select 1 from member m join "user" u on u.id = m.user_id'
                    " where m.organization_id = $1 and m.user_id = $2 and u.email_verified"
                    " and (select count(*) from invitation i where lower(i.email) = lower(u.email)"
                    " and i.status = 'accepted') = 1",
                    r.orgId,
                    r.userId,
                )
            )
        if rule["trigger"] == "referral.converted":
            return await _referral_ok(conn, r.orgId, r.subject, self.block_same_domain)
        if rule["trigger"] == "org.profile_completed":
            parsed: Any = json.loads(org["metadata"] or "{}")
            meta = cast(dict[str, Any], parsed) if isinstance(parsed, dict) else {}
            return all(str(meta.get(k) or "").strip() for k in rule["requiredMetadata"])
        return True

    @activity.defn(name="reward_apply")
    async def apply(self, r: RewardRequest) -> Applied:
        """Entitlements apply on our side; anything else goes through the API's billing provider
        (POST /internal/rewards/apply), keyed by the workflow id so a retry never credits twice."""
        reward = self.rules[r.ruleId]["reward"]
        if reward["kind"] == "entitlement":
            return Applied("entitlement", reward)
        if not (self.api_url and self.api_token):
            return Applied("manual", reward)  # no API link configured: operators apply it
        res = await self.http.post(
            f"{self.api_url}/internal/rewards/apply",
            json={"orgId": r.orgId, "ruleId": r.ruleId, "key": activity.info().workflow_id},
            headers={"Authorization": f"Bearer {self.api_token}"},
        )
        if 400 <= res.status_code < 500:  # wrong token or rule: retrying will not help
            raise ApplicationError(f"API refused the reward: {res.status_code}", non_retryable=True)
        res.raise_for_status()  # 5xx: retried by the workflow's policy
        body: dict[str, Any] = res.json()
        return Applied(body["via"], body["reward"], body["ref"])

    @activity.defn(name="reward_record")
    async def record(self, r: RewardRequest, a: Applied) -> bool:
        """Settles the reservation and writes its audit row (once)."""
        status = "pending_manual" if a.via == "manual" else "applied"
        months = int(a.reward["months"]) if a.via == "entitlement" else None
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", r.orgId)
            grant_id = await conn.fetchval(
                "update reward_grants set status = $3, via = $4, reward = $5::jsonb,"
                " provider_ref = $6, expires_at = case when $7::int is null then null"
                " else now() + make_interval(months => $7) end"
                " where rule_id = $1 and subject = $2 and status = 'reserved' returning id",
                r.ruleId,
                r.subject,
                status,
                a.via,
                json.dumps(a.reward),
                a.ref,
                months,
            )
            if grant_id is None:
                return False  # already settled by an earlier attempt
            # The audit row is the event operators and org admins see (docs/admin.md).
            await conn.execute(
                "insert into audit_log (org_id, actor_id, action, target) values ($1, 'rewards',"
                " $2, $3)",
                r.orgId,
                f"reward.{status}",
                str(grant_id),
            )
        granted.add(1, {"rule": r.ruleId, "via": a.via})
        if status == "pending_manual":
            log.warning("reward %s for org %s waits for an operator", grant_id, r.orgId)
        return True
