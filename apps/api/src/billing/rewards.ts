import { readFileSync } from 'node:fs';
import { subscriptions, withOrg } from '@app/db';
import * as Sentry from '@sentry/node-core';
import { z } from 'zod';
import { db } from '../db.ts';
import { isEnabled } from '../flags.ts';
import { startReward } from '../temporal.ts';
import type { Subscription } from './entitlements.ts';
import { minorUnits } from './money.ts';
import type { BillingProvider } from './provider.ts';
import { providerFor } from './registry.ts';

/** config/rewards.json (docs/growth.md). Also read by the worker (worker/rewards.py). */
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Entitlement = z
  .object({
    kind: z.literal('entitlement'),
    key: z.enum(['seats', 'projects', 'llmSpendMonthly']),
    delta: z.number().positive(),
    months: z.number().int().positive(),
    /** llmSpendMonthly only: the cost currency it raises. */
    currency: Currency.optional(),
  })
  .refine((e) => (e.key === 'llmSpendMonthly') === Boolean(e.currency), {
    message: 'currency is set exactly on llmSpendMonthly entitlements',
  });
const Reward = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('balance_credit'),
      amount: z.string().regex(/^\d+(\.\d+)?$/),
      currency: Currency,
    })
    .refine((m) => (m.amount.split('.')[1]?.length ?? 0) === minorUnits(m.currency), {
      message: "amount has the currency's minor-unit digits (money.ts): 5.00 USD, 500 JPY",
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

export type Via = 'entitlement' | 'balance_credit' | 'coupon' | 'manual';

/**
 * The one dispatcher. A paying org whose invoices are not issued by a configured provider
 * (`invoicing: 'external'`, no adapter): operators (`manual`). A provider customer: its method for
 * the reward (a coupon needs a live subscription; a credit, the customer's currency). Otherwise
 * the rule's entitlement fallback, else operators. Never drops a reward.
 */
export function dispatch(
  rule: Rule,
  sub: Subscription | null,
  p: BillingProvider | null,
): { via: Via; reward: Reward } {
  const r = rule.reward;
  if (r.kind === 'entitlement') return { via: 'entitlement', reward: r };
  if (sub && (!p || p.invoicing === 'external')) return { via: 'manual', reward: r };
  if (sub?.customerId && p) {
    const live = Boolean(sub.providerSubscriptionId) && sub.status !== 'canceled';
    if (r.kind === 'coupon' && p.applyCoupon && live) return { via: 'coupon', reward: r };
    if (r.kind === 'balance_credit' && p.applyCredit && r.currency === sub.currency) {
      return { via: 'balance_credit', reward: r };
    }
  }
  return rule.fallback
    ? { via: 'entitlement', reward: rule.fallback }
    : { via: 'manual', reward: r };
}

const providerOrNull = (contour: string) => {
  try {
    return providerFor(contour);
  } catch {
    return null; // a contour without a configured adapter: nothing to call
  }
};

/** Applies a rule's reward for the org (called by the worker, routes/rewards.ts). `key` is the
 * provider idempotency key: the workflow id. */
export async function applyReward(orgId: string, rule: Rule, key: string) {
  const [sub] = await withOrg(db, orgId, (tx) => tx.select().from(subscriptions));
  const p = sub ? providerOrNull(sub.contour) : null;
  const d = dispatch(rule, sub ?? null, p);
  let ref: string | null = null;
  if (d.via === 'coupon' && d.reward.kind === 'coupon') {
    ref = await p!.applyCoupon!(sub!, { couponId: d.reward.couponId, key });
  } else if (d.via === 'balance_credit' && d.reward.kind === 'balance_credit') {
    const { amount, currency } = d.reward;
    ref = await p!.applyCredit!(sub!, { amount, currency, description: `Reward: ${rule.id}`, key });
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
