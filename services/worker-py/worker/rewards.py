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


@dataclass(frozen=True)
class Reservation:
    """A reserved grant: the rule's reward and, if an earlier run applied it, how."""

    reward: dict[str, Any]
    applied: Applied | None = None


def load_rules(path: Path) -> dict[str, dict[str, Any]]:
    """config/rewards.json by rule id (the API validates its schema, apps/api/test)."""
    return {r["id"]: r for r in json.loads(path.read_text())["rules"]}


def same_domain_blocked(path: Path) -> bool:
    """config/rewards.json `referral.blockSameEmailDomain` (default off)."""
    return bool(json.loads(path.read_text()).get("referral", {}).get("blockSameEmailDomain"))


async def _referral_ok(conn: Any, referrer: str, referred: str, block_domain: bool) -> bool:
    """referral.converted guards: not the org itself; the referred subscription still active and
    renewing after the hold (a refund or dispute cancels the workflow before, in the API);
    optionally no owner email domain shared by both orgs. The API also refuses a card the
    referrer pays with (billing/referrals.ts)."""
    if referrer == referred:
        return False
    await conn.execute("select set_config('app.org_id', $1, true)", referred)
    active = await conn.fetchval(
        "select status = 'active' and not cancel_at_period_end from subscriptions"
    )
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
    async def reserve(self, r: RewardRequest) -> Reservation | None:
        """Reserves the grant if the conditions hold now, else None. `applied` is set when an
        earlier run got that far: settle it, do not apply again.

        One transaction under an advisory lock on (org, rule), so concurrent workflows of one org
        never pass the cap together. A subject gets a rule once, ever. A reservation found again
        (a retry, or a re-run after Temporal forgot the id) is settled with the provider object
        stored by `apply`; one older than a day without it goes to operators, since the provider's
        idempotency key may have expired and a second call could credit twice.
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
                "select status, via, reward, provider_ref, idempotency_key,"
                " created_at < now() - interval '1 day' as stale"
                " from reward_grants where rule_id = $1 and subject = $2",
                r.ruleId,
                r.subject,
            )
            if mine is not None:
                if mine["status"] != "reserved" or mine["idempotency_key"] != key:
                    return None
                if mine["via"] is not None:  # applied, not settled yet
                    done = Applied(mine["via"], json.loads(mine["reward"]), mine["provider_ref"])
                    return Reservation(rule["reward"], done)
                if mine["stale"]:
                    return Reservation(rule["reward"], Applied("manual", rule["reward"]))
                return Reservation(rule["reward"])
            ok = await self._conditions(conn, r, rule)
            if ok:
                count: int = await conn.fetchval(
                    "select count(*) from reward_grants where rule_id = $1"
                    " and status <> 'released'",
                    r.ruleId,
                )
                ok = count < rule["capPerOrg"]
            if ok and rule["trigger"] == "invitation.accepted":
                # Abuse guard: an account counts for one organization, ever (keyed by user id;
                # kept when memberships or invitations change).
                ok = r.orgId == await conn.fetchval(
                    'update "user" set invite_reward_org_id = coalesce(invite_reward_org_id, $1)'
                    " where id = $2 returning invite_reward_org_id",
                    r.orgId,
                    r.userId,
                )
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
        return Reservation(rule["reward"])

    async def _conditions(self, conn: Any, r: RewardRequest, rule: dict[str, Any]) -> bool:
        org = await conn.fetchrow(
            "select metadata, suspended_at from organization where id = $1", r.orgId
        )
        if org is None or org["suspended_at"] is not None:
            return False
        if rule["trigger"] == "invitation.accepted":
            # Abuse guard: a verified account, still a member after the hold.
            return bool(
                await conn.fetchval(
                    'select 1 from member m join "user" u on u.id = m.user_id'
                    " where m.organization_id = $1 and m.user_id = $2 and u.email_verified",
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
        done = Applied(body["via"], body["reward"], body["ref"])
        # Stored at once: a re-run settles with it instead of calling the provider again.
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", r.orgId)
            await conn.execute(
                "update reward_grants set via = $3, reward = $4::jsonb, provider_ref = $5"
                " where rule_id = $1 and subject = $2 and status = 'reserved'",
                r.ruleId,
                r.subject,
                done.via,
                json.dumps(done.reward),
                done.ref,
            )
        return done

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
