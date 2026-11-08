import { readFileSync } from 'node:fs';
import { subscriptions, withOrg } from '@app/db';
import * as Sentry from '@sentry/node-core';
import { z } from 'zod';
import { db } from '../db.ts';
import { isEnabled } from '../flags.ts';
import { startReward } from '../temporal.ts';
import type { Subscription } from './entitlements.ts';
import type { BillingProvider, RewardPrimitive } from './provider.ts';
import { providerFor } from './registry.ts';

/** config/rewards.json (docs/growth.md). Also read by the worker (worker/rewards.py). */
const Entitlement = z.object({
  kind: z.literal('entitlement'),
  key: z.enum(['seats', 'projects', 'llmSpendMonthly']),
  delta: z.number().positive(),
  months: z.number().int().positive(),
});
const Reward = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('balance_credit'),
    amount: z.string().regex(/^\d+\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  z.object({ kind: z.literal('coupon'), couponId: z.string().min(1) }),
  Entitlement,
]);
/** Server-side events only; client analytics events can be forged and never grant anything. */
export const TRIGGERS = [
  'org.profile_completed',
  'invitation.accepted',
  'referral.converted',
] as const;
export type Trigger = (typeof TRIGGERS)[number];
const Rule = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    trigger: z.enum(TRIGGERS),
    reward: Reward,
    fallback: Entitlement.optional(),
    capPerOrg: z.number().int().positive(),
    holdDays: z.number().int().nonnegative().default(0),
    requiredMetadata: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((r) => (r.trigger === 'org.profile_completed') === Boolean(r.requiredMetadata), {
    message: 'requiredMetadata is set exactly on org.profile_completed rules',
  });
export const RewardsConfig = z
  .object({
    version: z.number().int(),
    rules: z.array(Rule),
    /** Referrals (docs/growth.md): the referred customer's discount and a fraud guard. */
    referral: z
      .object({ couponId: z.string().min(1), blockSameEmailDomain: z.boolean() })
      .optional(),
  })
  .refine((c) => new Set(c.rules.map((r) => r.id)).size === c.rules.length, 'duplicate rule id');
export type Reward = z.infer<typeof Reward>;
export type Rule = z.infer<typeof Rule>;

export const rewards = RewardsConfig.parse(
  JSON.parse(readFileSync(new URL('../../../../config/rewards.json', import.meta.url), 'utf8')),
);
export const ruleById = (id: string) => rewards.rules.find((r) => r.id === id);

/** What the org's billing allows: no PSP (contract invoiced outside it, adapter not configured),
 * no provider customer (free), or the primitives usable for its customer now. */
export type Setup =
  | { kind: 'manual' }
  | { kind: 'no_customer' }
  | { kind: 'provider'; currency: string; primitives: RewardPrimitive[] };
export type Via = 'entitlement' | RewardPrimitive | 'manual';

/**
 * The one dispatcher: the provider's native primitive when it has one for this reward, else the
 * rule's entitlement fallback, else operators (`manual`). Never drops a reward.
 */
export function dispatch(rule: Rule, setup: Setup): { via: Via; reward: Reward } {
  const r = rule.reward;
  if (r.kind === 'entitlement') return { via: 'entitlement', reward: r };
  if (setup.kind === 'manual') return { via: 'manual', reward: r };
  if (setup.kind === 'provider') {
    const has = (p: RewardPrimitive) => setup.primitives.includes(p);
    if (r.kind === 'coupon' && has('coupon')) return { via: 'coupon', reward: r };
    if (r.kind === 'balance_credit' && r.currency === setup.currency) {
      if (has('credit_grant')) return { via: 'credit_grant', reward: r }; // usage-based prices
      if (has('balance_credit')) return { via: 'balance_credit', reward: r };
    }
  }
  return rule.fallback
    ? { via: 'entitlement', reward: rule.fallback }
    : { via: 'manual', reward: r };
}

export async function billingSetup(
  sub: Subscription | null,
  providerOf: (contour: string) => BillingProvider = providerFor,
): Promise<Setup> {
  if (!sub) return { kind: 'no_customer' };
  let p: BillingProvider;
  try {
    p = providerOf(sub.contour);
  } catch {
    return { kind: 'manual' }; // a contour without a configured adapter: nothing to call
  }
  const caps = p.capabilities();
  if (caps.invoicing === 'external') return { kind: 'manual' }; // contract invoiced by hand
  if (!sub.customerId) return { kind: 'no_customer' };
  const recurring = Boolean(sub.providerSubscriptionId) && sub.status !== 'canceled';
  const primitives: RewardPrimitive[] = [];
  if (caps.creditGrants && recurring && p.applyCredit && (await p.usageBased?.(sub))) {
    primitives.push('credit_grant');
  }
  if (caps.balanceCredit && p.applyCredit) primitives.push('balance_credit');
  if (caps.coupons && recurring && p.applyCoupon) primitives.push('coupon');
  return { kind: 'provider', currency: sub.currency, primitives };
}

/** Applies a rule's reward for the org (called by the worker, routes/rewards.ts). `key` is the
 * provider idempotency key: the workflow id. */
export async function applyReward(orgId: string, rule: Rule, key: string) {
  const [sub] = await withOrg(db, orgId, (tx) => tx.select().from(subscriptions));
  const d = dispatch(rule, await billingSetup(sub ?? null));
  const p = sub && d.via !== 'entitlement' && d.via !== 'manual' ? providerFor(sub.contour) : null;
  let ref: string | null = null;
  if (p?.applyCoupon && d.reward.kind === 'coupon') {
    ref = await p.applyCoupon(sub!, { couponId: d.reward.couponId, key });
  } else if (p?.applyCredit && d.reward.kind === 'balance_credit') {
    const via = d.via === 'credit_grant' ? 'credit_grant' : 'balance_credit';
    const { amount, currency } = d.reward;
    ref = await p.applyCredit(sub!, {
      via,
      amount,
      currency,
      description: `Reward: ${rule.id}`,
      key,
    });
  }
  return { ...d, ref };
}

const record = (m: unknown): Record<string, unknown> => {
  if (typeof m === 'string') {
    try {
      return record(JSON.parse(m));
    } catch {
      return {};
    }
  }
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
};
/** Org metadata (Better Auth keeps it as a JSON string) has every key, non-empty. */
export const profileComplete = (keys: string[], metadata: unknown) => {
  const m = record(metadata);
  return keys.every((k) => m[k] !== undefined && m[k] !== null && String(m[k]).trim() !== '');
};

/**
 * Starts a RewardWorkflow for each rule of `trigger` (flag `rewards`). Call it after the change
 * committed. Never throws: a Temporal outage must not fail the user's action. Returns how many
 * workflows started (0 for duplicates).
 */
export async function triggerRewards(
  trigger: Trigger,
  e: { orgId: string; subject: string; userId: string; metadata?: unknown },
): Promise<number> {
  try {
    if (!(await isEnabled('rewards', { userId: e.userId, orgId: e.orgId }))) return 0;
    let started = 0;
    for (const rule of rewards.rules) {
      if (rule.trigger !== trigger) continue;
      if (rule.requiredMetadata && !profileComplete(rule.requiredMetadata, e.metadata)) continue;
      const req = { orgId: e.orgId, ruleId: rule.id, subject: e.subject, userId: e.userId };
      if (await startReward({ ...req, holdDays: rule.holdDays })) started++;
    }
    return started;
  } catch (err) {
    Sentry.captureException(err);
    return 0;
  }
}
