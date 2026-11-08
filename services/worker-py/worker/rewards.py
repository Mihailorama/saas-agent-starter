"""Rewards (docs/growth.md): the activities of RewardWorkflow.

The API starts the workflow on a server-side trigger (apps/api/src/billing/rewards.ts). The worker
waits the rule's `holdDays`, checks the conditions and the per-org cap (`eligible`), has the API
apply money and coupon rewards through the billing provider (`apply`: the provider adapters live
in the API), then appends the grant to `reward_grants` (`record`). A reward the provider cannot
apply is recorded as `pending_manual` for operators: never dropped.
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
    """How it was given: `via` is entitlement, credit_grant, balance_credit, coupon or manual."""

    via: str
    reward: dict[str, Any]
    ref: str | None = None


def load_rules(path: Path) -> dict[str, dict[str, Any]]:
    """config/rewards.json by rule id (the API validates its schema, apps/api/test)."""
    return {r["id"]: r for r in json.loads(path.read_text())["rules"]}


def same_domain_blocked(path: Path) -> bool:
    """config/rewards.json `referral.blockSameEmailDomain`."""
    return bool(json.loads(path.read_text()).get("referral", {}).get("blockSameEmailDomain"))


async def _referral_ok(conn: Any, referrer: str, referred: str, block_domain: bool) -> bool:
    """Fraud guards for referral.converted: not the org itself, not the same provider customer,
    and (configurable) no owner email domain shared by both orgs."""
    if referrer == referred:
        return False
    customers: list[str | None] = []
    for org in (referrer, referred):  # each subscription row under its own org's RLS scope
        await conn.execute("select set_config('app.org_id', $1, true)", org)
        customers.append(await conn.fetchval("select customer_id from subscriptions"))
    await conn.execute("select set_config('app.org_id', $1, true)", referrer)
    if customers[0] is not None and customers[0] == customers[1]:
        return False
    # ponytail: blocks two gmail.com owners too; add a public-domain list if that matters.
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

    @activity.defn(name="reward_eligible")
    async def eligible(self, r: RewardRequest) -> dict[str, Any] | None:
        """The rule's reward if the conditions hold now and the cap is not reached, else None."""
        rule = self.rules.get(r.ruleId)
        if rule is None:
            log.warning("reward rule %s is no longer configured", r.ruleId)
            return None
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", r.orgId)
            org = await conn.fetchrow(
                "select metadata, suspended_at from organization where id = $1", r.orgId
            )
            # ponytail: grants in flight for one org can overshoot the cap by their number;
            # take an advisory lock on (org, rule) here if that ever matters.
            count: int = await conn.fetchval(
                "select count(*) from reward_grants where rule_id = $1", r.ruleId
            )
            ok = org is not None and org["suspended_at"] is None and count < rule["capPerOrg"]
            if ok and rule["trigger"] == "invitation.accepted":
                # Abuse guard: only a verified account that is still a member after the hold.
                ok = bool(
                    await conn.fetchval(
                        'select 1 from member m join "user" u on u.id = m.user_id'
                        " where m.organization_id = $1 and m.user_id = $2 and u.email_verified",
                        r.orgId,
                        r.userId,
                    )
                )
            if ok and rule["trigger"] == "referral.converted":
                ok = await _referral_ok(conn, r.orgId, r.subject, self.block_same_domain)
            if ok and rule["trigger"] == "org.profile_completed":
                assert org is not None
                parsed: Any = json.loads(org["metadata"] or "{}")
                meta = cast(dict[str, Any], parsed) if isinstance(parsed, dict) else {}
                ok = all(str(meta.get(k) or "").strip() for k in rule["requiredMetadata"])
        if not ok:
            log.info("reward %s for org %s: not eligible", r.ruleId, r.orgId)
            return None
        return rule["reward"]

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
        """Appends the grant (once per org, rule and subject) and its audit row."""
        status = "pending_manual" if a.via == "manual" else "applied"
        months = int(a.reward["months"]) if a.via == "entitlement" else None
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", r.orgId)
            grant_id = await conn.fetchval(
                "insert into reward_grants (org_id, rule_id, subject, via, status, reward,"
                " provider_ref, expires_at) values ($1, $2, $3, $4, $5, $6::jsonb, $7,"
                " case when $8::int is null then null else now() + make_interval(months => $8) end)"
                " on conflict (org_id, rule_id, subject) do nothing returning id",
                r.orgId,
                r.ruleId,
                r.subject,
                a.via,
                status,
                json.dumps(a.reward),
                a.ref,
                months,
            )
            if grant_id is None:
                return False
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
