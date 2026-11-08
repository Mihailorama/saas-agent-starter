import { aiCalls, organization, rewardGrants, subscriptions, type Tx, withOrg } from '@app/db';
import { and, eq, gt, gte, lt, sum } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db.ts';
import { type Limit, type Plan, planById, plans } from './plans.ts';

export type Subscription = typeof subscriptions.$inferSelect;
export type Entitlements = {
  planId: string;
  plan: Plan;
  subscription: Subscription | null;
  /** Billing period the LLM spend is counted in: the paid period, else the calendar month. */
  period: { start: Date; end: Date };
  limits: Record<Limit, number>;
  features: Record<string, boolean>;
  /** Effective monthly LLM spend limit per cost currency (plan default or admin-raised). */
  llmSpendLimit: (currency: string) => number | undefined;
};

/** Statuses in which the paid plan applies; `past_due` is the grace period while retrying. */
const PAID = new Set(['active', 'past_due']);
const DAY = 86_400_000;

/** Paid plan in force: active, or past_due until pastDueGraceDays after the period end. */
function paid(sub: Subscription | null, now: Date): sub is Subscription {
  if (!sub || !PAID.has(sub.status)) return false;
  if (sub.status === 'active' || !sub.currentPeriodEnd) return true;
  return now.getTime() < sub.currentPeriodEnd.getTime() + plans.pastDueGraceDays * DAY;
}

export function billingPeriod(sub: Subscription | null, now = new Date()) {
  const start = sub?.currentPeriodStart;
  const end = sub?.currentPeriodEnd;
  if (paid(sub, now) && start && end && start <= now && now < end) {
    return { start, end };
  }
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** Operator overrides of seats/projects (organization.limit_overrides, docs/admin.md). */
export type LimitOverrides = Partial<Record<Limit, number>> | null;

/** The plan's limit, or an operator override capped by the plan's `limitsMax`. */
export const limitOf = (plan: Plan, name: Limit, overrides: LimitOverrides) => {
  const o = overrides?.[name];
  return o === undefined
    ? plan.limits[name]
    : Math.min(o, plan.limitsMax?.[name] ?? plan.limits[name]);
};

/** Unexpired entitlement rewards (reward_grants, docs/growth.md), summed per key. */
/** `llmSpendMonthly:<currency>` for spend rewards (one cost currency each). */
export type RewardBonus = Partial<Record<Limit | `llmSpendMonthly:${string}`, number>>;

export function entitlementsOf(
  sub: Subscription | null,
  now = new Date(),
  overrides: LimitOverrides = null,
  bonus: RewardBonus = {},
): Entitlements {
  const [planId, plan] = planById(paid(sub, now) ? sub.planId : null);
  const extra = (k: keyof RewardBonus) => bonus[k] ?? 0;
  return {
    planId,
    plan,
    subscription: sub,
    period: billingPeriod(sub, now),
    limits: {
      seats: limitOf(plan, 'seats', overrides) + extra('seats'),
      projects: limitOf(plan, 'projects', overrides) + extra('projects'),
    },
    features: plan.features,
    llmSpendLimit: (currency) => {
      const base = plan.limits.llmSpendMonthly[currency];
      const raised = plan.features.llmLimitRaise ? sub?.llmSpendLimits?.[currency] : undefined;
      const max = plan.llmSpendMax[currency] ?? base;
      const limit = raised === undefined || max === undefined ? base : Math.min(raised, max);
      // Only in the reward's currency (worker/billing.py does the same).
      return limit === undefined ? undefined : limit + extra(`llmSpendMonthly:${currency}`);
    },
  };
}

/** The organization's plan, limits and features. The one place that answers "may they?". */
export async function entitlements(orgId: string, tx?: Tx): Promise<Entitlements> {
  const read = async (t: Tx) => {
    const [sub] = await t.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
    const [org] = await t
      .select({ overrides: organization.limitOverrides })
      .from(organization)
      .where(eq(organization.id, orgId));
    const now = new Date();
    const grants = await t
      .select({ reward: rewardGrants.reward })
      .from(rewardGrants)
      .where(and(eq(rewardGrants.via, 'entitlement'), gt(rewardGrants.expiresAt, now)));
    const bonus: RewardBonus = {};
    for (const { reward } of grants) {
      const key = (
        reward.key === 'llmSpendMonthly' ? `llmSpendMonthly:${reward.currency}` : reward.key
      ) as keyof RewardBonus;
      bonus[key] = (bonus[key] ?? 0) + Number(reward.delta);
    }
    return entitlementsOf(sub ?? null, now, org?.overrides ?? null, bonus);
  };
  return tx ? read(tx) : withOrg(db, orgId, read);
}

/** LLM spend per cost currency in [start, end). Served by the (org_id, created_at) index. */
export async function llmSpend(tx: Tx, orgId: string, period: { start: Date; end: Date }) {
  const rows = await tx
    .select({ currency: aiCalls.costCurrency, spent: sum(aiCalls.cost) })
    .from(aiCalls)
    .where(
      and(
        eq(aiCalls.orgId, orgId),
        gte(aiCalls.createdAt, period.start),
        lt(aiCalls.createdAt, period.end),
      ),
    )
    .groupBy(aiCalls.costCurrency);
  return Object.fromEntries(
    rows.filter((r) => r.currency).map((r) => [r.currency!, Number(r.spent ?? 0)]),
  ) as Record<string, number>;
}

const knownFeatures = new Set(Object.values(plans.plans).flatMap((p) => Object.keys(p.features)));

/**
 * preHandler after requireRole: 402 unless the org's plan includes `name`. For a limit, `used`
 * counts the current usage inside the tenant transaction; the request needs one more.
 * ponytail: check-then-act, two concurrent requests can both pass at limit-1; add a row lock if
 * an overshoot of one ever matters.
 */
export function requireEntitlement(name: Limit, used: (tx: Tx) => Promise<number>): Guard;
export function requireEntitlement(name: string): Guard;
export function requireEntitlement(name: string, used?: (tx: Tx) => Promise<number>): Guard {
  const isLimit = name === 'seats' || name === 'projects';
  if (isLimit ? !used : !knownFeatures.has(name)) {
    throw new Error(`requireEntitlement: unknown feature or missing usage counter: ${name}`);
  }
  return async (req, reply) => {
    const { orgId } = req.tenant;
    const ok = await withOrg(db, orgId, async (tx) => {
      const e = await entitlements(orgId, tx);
      return isLimit ? (await used!(tx)) < e.limits[name as Limit] : e.features[name] === true;
    });
    if (!ok) {
      return reply.code(402).send({
        error: isLimit ? `plan limit reached: ${name}` : `not included in your plan: ${name}`,
      });
    }
  };
}
type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
