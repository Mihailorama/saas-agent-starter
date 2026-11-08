// Rewards (docs/growth.md): config, the dispatcher across billing setups, the Stripe primitives
// against stripe-mock, entitlement bumps, the worker's internal route and the triggers (flag on/off).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rewardGrants, subscriptions, withOrg } from '@app/db';
import { WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { OrgMetadata } from '../src/auth.ts';
import { entitlements, type Subscription } from '../src/billing/entitlements.ts';
import type { BillingProvider } from '../src/billing/provider.ts';
import { providerFor } from '../src/billing/registry.ts';
import {
  dispatch,
  RewardsConfig,
  type Rule,
  rewards,
  triggerRewards,
} from '../src/billing/rewards.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { closeTemporal, rewardWorkflowId, temporal } from '../src/temporal.ts';
import { signUp as codeSignUp } from './sign-in.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
const flag = (on: boolean) =>
  env.FLAGS_ON.splice(0, env.FLAGS_ON.length, ...(on ? ['rewards'] : []));
afterAll(async () => {
  flag(false);
  await app.close();
  await closeTemporal();
  await pool.end();
});

type User = { id: string; cookie: string };
const signUp = (email?: string): Promise<User> => codeSignUp(app, email);
const post = (u: User, url: string, payload: object) =>
  app.inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    headers: { origin, cookie: u.cookie },
    payload,
  });
async function ownerWithOrg() {
  const owner = await signUp();
  const res = await post(owner, '/api/auth/organization/create', {
    name: 'Org',
    slug: randomUUID(),
  });
  return { owner, org: res.json().id as string };
}
const workflowExists = async (id: string) => {
  try {
    await (await temporal()).workflow.getHandle(id).describe();
    return true;
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return false;
    throw err;
  }
};
const sub = (over: Partial<Subscription> = {}): Subscription => ({
  orgId: 'o',
  planId: 'pro',
  status: 'active',
  contour: 'en',
  provider: 'stripe',
  currency: 'USD',
  customerId: 'cus_123',
  providerSubscriptionId: 'sub_123',
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  seats: null,
  contractRef: null,
  usageReportedUntil: null,
  llmSpendLimits: null,
  lastEventAt: null,
  updatedAt: new Date(),
  ...over,
});

const money: Rule = {
  id: 'm',
  trigger: 'invitation.accepted',
  reward: { kind: 'balance_credit', amount: '5.00', currency: 'USD' },
  fallback: { kind: 'entitlement', key: 'llmSpendMonthly', delta: 2, months: 3, currency: 'USD' },
  capPerOrg: 1,
  holdDays: 0,
};

describe('config/rewards.json', () => {
  it('parses, and the schema rejects broken rules', () => {
    const file = JSON.parse(
      readFileSync(new URL('../../../config/rewards.json', import.meta.url), 'utf8'),
    );
    expect(RewardsConfig.safeParse(file).success).toBe(true);
    const bad = (rule: object) => RewardsConfig.safeParse({ version: 1, rules: [rule] }).success;
    expect(
      bad({ ...money, reward: { kind: 'balance_credit', amount: '5', currency: 'USD' } }),
    ).toBe(false);
    expect(bad({ ...money, trigger: 'button_clicked' })).toBe(false); // client events never count
    expect(
      bad({ ...money, reward: { kind: 'balance_credit', amount: '500.00', currency: 'JPY' } }),
    ).toBe(false); // JPY has no minor digits (money.ts)
    const yen = { kind: 'balance_credit', amount: '500', currency: 'JPY' };
    expect(bad({ ...money, reward: yen })).toBe(true);
    const spend = { kind: 'entitlement', key: 'llmSpendMonthly', delta: 2, months: 1 };
    expect(bad({ ...money, fallback: spend })).toBe(false); // spend rewards name their currency
    expect(bad({ ...money, trigger: 'org.profile_completed' })).toBe(false); // no requiredMetadata
    expect(RewardsConfig.safeParse({ version: 1, rules: [money, money] }).success).toBe(false);
  });
  it('org.profile_completed rules need only the metadata keys the API validates (OrgMetadata)', () => {
    const valid = Object.keys(OrgMetadata.shape);
    for (const r of rewards.rules.filter((x) => x.trigger === 'org.profile_completed')) {
      expect(valid).toEqual(expect.arrayContaining(r.requiredMetadata!));
    }
  });
});

describe('dispatch across billing setups', () => {
  const stripe = providerFor('en');
  const external = { invoicing: 'external' } as BillingProvider;
  const coupon: Rule = { ...money, reward: { kind: 'coupon', couponId: 'co_1' } };
  it('a provider customer: the balance (flat, per-seat and metered alike) or a coupon', () => {
    expect(dispatch(money, sub(), stripe).via).toBe('balance_credit');
    expect(dispatch(coupon, sub(), stripe).via).toBe('coupon');
    // A coupon needs a live subscription; a credit, the customer's currency: else the fallback.
    expect(dispatch(coupon, sub({ status: 'canceled' }), stripe).reward).toEqual(money.fallback);
    expect(dispatch(money, sub({ currency: 'EUR' }), stripe).via).toBe('entitlement');
  });
  it('free / no customer: the fallback entitlement, or operators without one', () => {
    expect(dispatch(money, null, null)).toEqual({ via: 'entitlement', reward: money.fallback });
    expect(dispatch(money, sub({ customerId: null }), stripe).via).toBe('entitlement');
    expect(dispatch({ ...money, fallback: undefined }, null, null).via).toBe('manual');
  });
  it('manual contract or no adapter: operators; entitlements apply everywhere', () => {
    expect(dispatch(money, sub(), external)).toEqual({ via: 'manual', reward: money.reward });
    expect(dispatch(money, sub({ contour: 'contract' }), null).via).toBe('manual');
    const ent = rewards.rules.find((r) => r.reward.kind === 'entitlement')!;
    expect(dispatch(ent, sub(), external).via).toBe('entitlement');
  });
  it('the Stripe methods return the provider object ids (stripe-mock)', async () => {
    const credit = { amount: '5.00', currency: 'USD', description: 'Reward: test' };
    expect(await stripe.applyCredit!(sub(), { ...credit, key: randomUUID() })).toMatch(/^cbtxn_/);
    expect(await stripe.applyCoupon!(sub(), { couponId: 'co_123', key: randomUUID() })).toMatch(
      /^sub_/,
    );
  });
});

describe('entitlement rewards', () => {
  it('raise limits until they expire', async () => {
    const { org } = await ownerWithOrg();
    const grant = (subject: string, reward: Record<string, unknown>, expiresAt: Date) =>
      withOrg(db, org, (tx) =>
        tx.insert(rewardGrants).values({
          orgId: org,
          ruleId: 'r',
          subject,
          via: 'entitlement',
          status: 'applied',
          reward,
          expiresAt,
          idempotencyKey: subject,
        }),
      );
    const later = new Date(Date.now() + 86_400_000);
    await grant('a', { kind: 'entitlement', key: 'projects', delta: 2, months: 1 }, later);
    const spend = { kind: 'entitlement', key: 'llmSpendMonthly', delta: 2, months: 1 };
    await grant('b', { ...spend, currency: 'USD' }, later);
    await grant(
      'c',
      { kind: 'entitlement', key: 'seats', delta: 9, months: 1 },
      new Date(Date.now() - 1000),
    );
    const e = await entitlements(org);
    expect(e.limits.projects).toBe(3 + 2);
    expect(e.limits.seats).toBe(3); // expired
    expect(e.llmSpendLimit('USD')).toBe(1 + 2);
    expect(e.llmSpendLimit('EUR')).toBe(1); // only in the reward's currency
  });
  it('reward_grants: no deletes, and updates only of the settlement columns', async () => {
    const { org } = await ownerWithOrg();
    await withOrg(db, org, (tx) => tx.update(rewardGrants).set({ status: 'applied' })); // allowed
    for (const write of [
      withOrg(db, org, (tx) => tx.delete(rewardGrants)),
      withOrg(db, org, (tx) => tx.update(rewardGrants).set({ subject: 'x' })),
    ]) {
      await expect(write).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/permission denied/) },
      });
    }
  });
});

describe('POST /internal/rewards/apply (worker -> API)', () => {
  const apply = (orgId: string, token?: string) =>
    app.inject({
      method: 'POST',
      url: '/internal/rewards/apply',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { orgId, ruleId: 'team-invite', key: randomUUID() },
    });
  it('is off without INTERNAL_API_TOKEN, and needs the token', async () => {
    const saved = env.INTERNAL_API_TOKEN;
    env.INTERNAL_API_TOKEN = undefined;
    expect((await apply('o', 'x')).statusCode).toBe(404);
    env.INTERNAL_API_TOKEN = 'test-internal-token';
    expect((await apply('o', 'wrong')).statusCode).toBe(401);
    expect((await apply('o')).statusCode).toBe(401);
    env.INTERNAL_API_TOKEN = saved;
  });
  it('credits a Stripe customer, falls back to the entitlement for a free org', async () => {
    const saved = env.INTERNAL_API_TOKEN;
    env.INTERNAL_API_TOKEN = 'test-internal-token';
    const { org } = await ownerWithOrg();
    const free = await apply(org, 'test-internal-token');
    expect(free.json()).toMatchObject({
      via: 'entitlement',
      reward: { key: 'projects' },
      ref: null,
    });
    await withOrg(db, org, (tx) => tx.insert(subscriptions).values({ ...sub(), orgId: org }));
    const paid = await apply(org, 'test-internal-token');
    expect(paid.json()).toMatchObject({
      via: 'balance_credit',
      ref: expect.stringMatching(/^cbtxn_/),
    });
    env.INTERNAL_API_TOKEN = saved;
  });
});

describe('triggers (flag rewards)', () => {
  it('flag off: nothing starts; on: once per rule and subject', async () => {
    const e = { orgId: randomUUID(), subject: randomUUID(), userId: 'u' };
    const id = rewardWorkflowId({ ...e, ruleId: 'team-invite' });
    flag(false);
    expect(await triggerRewards('invitation.accepted', e)).toBe(0);
    expect(await workflowExists(id)).toBe(false);
    flag(true);
    expect(await triggerRewards('invitation.accepted', e)).toBe(1);
    expect(await triggerRewards('invitation.accepted', e)).toBe(0); // REJECT_DUPLICATE
    expect(await workflowExists(id)).toBe(true);
    flag(false);
  });
  it('accepting an invitation and completing the org profile start the rule workflows', async () => {
    flag(true);
    const { owner, org } = await ownerWithOrg();
    const email = `${randomUUID()}@example.com`;
    const invited = await post(owner, '/api/auth/organization/invite-member', {
      email,
      role: 'member',
      organizationId: org,
    });
    const invitee = await signUp(email);
    const accepted = await post(invitee, '/api/auth/organization/accept-invitation', {
      invitationId: invited.json().id,
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      await workflowExists(
        rewardWorkflowId({ orgId: org, ruleId: 'team-invite', subject: invitee.id }),
      ),
    ).toBe(true);

    const profile = rewardWorkflowId({ orgId: org, ruleId: 'org-profile', subject: org });
    const update = (metadata: object) =>
      post(owner, '/api/auth/organization/update', { organizationId: org, data: { metadata } });
    expect((await update({ website: 'https://example.com' })).statusCode).toBe(200);
    expect(await workflowExists(profile)).toBe(false); // size missing
    expect((await update({ website: 'https://example.com', size: '11-50' })).statusCode).toBe(200);
    expect(await workflowExists(profile)).toBe(true);
    flag(false);
  });
});
