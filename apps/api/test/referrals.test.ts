// Referrals (docs/growth.md): link, attribution at sign-up, self-referral, checkout discount, the
// invoice.paid conversion and the referrer's reward; Dub Partners with a mocked fetch.
import { randomUUID } from 'node:crypto';
import { organization, subscriptions, user, withOrg } from '@app/db';
import { WorkflowNotFoundError } from '@temporalio/client';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { plans } from '../src/billing/plans.ts';
import { attachReferral, checkoutReferral, onReferralEvent } from '../src/billing/referrals.ts';
import { providerFor } from '../src/billing/registry.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { closeTemporal, rewardWorkflowId, temporal } from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
const flags = (...on: string[]) => env.FLAGS_ON.splice(0, env.FLAGS_ON.length, ...on);
afterEach(() => {
  flags();
  env.DUB_API_KEY = undefined;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await app.close();
  await closeTemporal();
  await pool.end();
});

type User = { id: string; cookie: string };
async function signUp(referralCode?: string): Promise<User> {
  const email = `${randomUUID()}@example.com`;
  const password = 'correct-horse-battery';
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    remoteAddress: ip(),
    headers: { origin },
    payload: { email, password, name: 'T', ...(referralCode && { referralCode }) },
  });
  const id: string = res.json().user.id;
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, id));
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress: ip(),
    headers: { origin },
    payload: { email, password },
  });
  return { id, cookie: signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
}
const createOrg = async (u: User) =>
  (
    await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      remoteAddress: ip(),
      headers: { origin, cookie: u.cookie },
      payload: { name: 'Org', slug: randomUUID() },
    })
  ).json().id as string;
const getReferral = (u: User) =>
  app.inject({ method: 'GET', url: '/api/referrals/', headers: { origin, cookie: u.cookie } });
const referredBy = async (orgId: string) =>
  (await db.select().from(organization).where(eq(organization.id, orgId)))[0]?.referredBy;
const workflowExists = async (id: string) =>
  (await temporal()).workflow
    .getHandle(id)
    .describe()
    .then(() => true)
    .catch((err) => (err instanceof WorkflowNotFoundError ? false : Promise.reject(err)));

describe('native referrals (Stripe promotion codes)', () => {
  it('flag off: no referral page and no attribution', async () => {
    const owner = await signUp();
    await createOrg(owner);
    expect((await getReferral(owner)).statusCode).toBe(404);
  });

  it('link -> sign-up -> org attributed -> discounted checkout -> paid invoice rewards the referrer', async () => {
    flags('referrals', 'rewards');
    const referrer = await signUp();
    const a = await createOrg(referrer);
    const first = (await getReferral(referrer)).json();
    expect(first).toMatchObject({ via: 'native', rewarded: 0 });
    expect((await getReferral(referrer)).json().link).toBe(first.link); // one code per org
    const code = new URL(first.link).searchParams.get('ref')!;

    const referred = await signUp(code);
    const b = await createOrg(referred);
    expect(await referredBy(b)).toBe(a);
    expect(await checkoutReferral(b)).toEqual({ promotionCode: code, referrerOrgId: a });
    // stripe-mock accepts the session with the promotion code and the referrer in metadata.
    const checkout = await providerFor('en').checkout!({
      orgId: b,
      planId: 'pro',
      planName: 'Pro',
      currency: 'USD',
      prices: plans.plans.pro!.prices.USD!,
      seats: 1,
      customerId: null,
      returnUrl: 'https://app.example.com/settings/billing',
      referral: (await checkoutReferral(b))!,
    });
    expect(checkout.url).toBeTruthy();

    const url = new URL(env.STRIPE_API_URL!);
    const stripe = new Stripe('sk_test_123', {
      host: url.hostname,
      port: url.port,
      protocol: 'http',
    });
    const invoice = (amount: number, reason = 'subscription_cycle', customer = 'cus_b') => ({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'in_1',
          object: 'invoice',
          amount_paid: amount,
          currency: 'usd',
          billing_reason: reason,
          customer,
          parent: { subscription_details: { metadata: { orgId: b, referrerOrgId: a } } },
        },
      },
    });
    const events = async (body: object) => {
      const payload = JSON.stringify(body);
      const signature = await stripe.webhooks.generateTestHeaderStringAsync({
        payload,
        secret: env.STRIPE_WEBHOOK_SECRET!,
      });
      return providerFor('en').webhook({
        body: payload,
        headers: { 'stripe-signature': signature },
        ip: '',
      });
    };
    // The first invoice never converts (paid once, refund-and-leave); the second paid period
    // does, with an amount (a $0 trial first invoice is no obstacle).
    const created = await events(invoice(2900, 'subscription_create'));
    expect(created.map((e) => e.type)).toEqual(['payment.succeeded']);
    expect((await events(invoice(0))).map((e) => e.type)).toEqual(['payment.succeeded']);
    const paid = await events(invoice(2900));
    expect(paid.map((e) => e.type)).toEqual(['payment.succeeded', 'referral.converted']);
    for (const e of paid) await onReferralEvent(e);
    const rewardId = rewardWorkflowId({ orgId: a, ruleId: 'referral', subject: b });
    expect(await workflowExists(rewardId)).toBe(true);

    // A refund or dispute cancels the reward while it waits out its hold.
    const refund = {
      id: `evt_${randomUUID()}`,
      object: 'event',
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'ch_1', object: 'charge', customer: 'cus_b' } },
    };
    expect(Array.isArray(await events(refund))).toBe(true); // maps through the subscriptions
    await onReferralEvent({ ...paid[1]!, eventId: 'evt_refund', type: 'referral.voided' });
    const run = await (await temporal()).workflow.getHandle(rewardId).describe();
    expect(run.status.name).toBe('TERMINATED');

    // Same payer: a paying referrer whose saved card is the referred customer's (stripe-mock
    // returns the same card for every customer) gets nothing.
    const c = await createOrg(await signUp());
    await withOrg(db, a, (tx) =>
      tx.insert(subscriptions).values({
        orgId: a,
        planId: 'pro',
        status: 'active',
        contour: 'en',
        provider: 'stripe',
        currency: 'USD',
        customerId: 'cus_a',
      }),
    );
    for (const e of paid) await onReferralEvent({ ...e, orgId: c });
    expect(
      await workflowExists(rewardWorkflowId({ orgId: a, ruleId: 'referral', subject: c })),
    ).toBe(false);
  });

  it('refuses self-referral and malformed codes', async () => {
    flags('referrals');
    const owner = await signUp();
    await createOrg(owner);
    const code = new URL((await getReferral(owner)).json().link).searchParams.get('ref')!;
    await db.update(user).set({ referralCode: code }).where(eq(user.id, owner.id));
    const second = await createOrg(owner); // a member of the referring org
    expect(await referredBy(second)).toBeNull();
    const bad = await signUp('<script>');
    expect((await db.select().from(user).where(eq(user.id, bad.id)))[0]?.referralCode).toBeNull();
    // Only the sign-up sets it: update-user cannot.
    await app.inject({
      method: 'POST',
      url: '/api/auth/update-user',
      remoteAddress: ip(),
      headers: { origin, cookie: bad.cookie },
      payload: { referralCode: code },
    });
    expect((await db.select().from(user).where(eq(user.id, bad.id)))[0]?.referralCode).toBeNull();
  });
});

describe('Dub Partners (DUB_API_KEY)', () => {
  it('links, leads and sales go to Dub', async () => {
    flags('referrals');
    env.DUB_API_KEY = 'dub_test';
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ links: [{ shortLink: 'https://refer.example.com/acme' }] });
    });
    const owner = await signUp();
    const org = await createOrg(owner);
    expect((await getReferral(owner)).json()).toMatchObject({
      via: 'dub',
      link: 'https://refer.example.com/acme',
    });
    expect(calls.at(-1)).toMatchObject({
      url: 'https://api.dub.co/partners',
      body: { tenantId: org },
    });
    const enrolled = calls.length;
    expect((await getReferral(owner)).json().link).toBe('https://refer.example.com/acme');
    expect(calls.length).toBe(enrolled); // kept in the row: Dub is not asked on every view

    const referred = await signUp();
    await db.update(user).set({ referralCode: 'dub_click_1' }).where(eq(user.id, referred.id));
    const b = randomUUID();
    await db.insert(organization).values({ id: b, name: 'B', slug: b, createdAt: new Date() });
    await attachReferral(b, referred.id);
    expect(await referredBy(b)).toBe('dub');
    expect(calls.at(-1)).toMatchObject({
      url: 'https://api.dub.co/track/lead',
      body: { clickId: 'dub_click_1', customerExternalId: b },
    });
    await onReferralEvent({
      provider: 'stripe',
      contour: 'en',
      eventId: 'evt_1',
      type: 'payment.succeeded',
      orgId: b,
      occurredAt: new Date().toISOString(),
      amount: 2900,
      currency: 'USD',
      invoiceId: 'in_1',
    });
    expect(calls.at(-1)).toMatchObject({
      url: 'https://api.dub.co/track/sale',
      body: { customerExternalId: b, amount: 2900, currency: 'usd', invoiceId: 'in_1' },
    });
  });

  it('a Dub outage fails neither the referral page nor the billing webhook', async () => {
    flags('referrals');
    env.DUB_API_KEY = 'dub_test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    const owner = await signUp();
    const org = await createOrg(owner);
    expect((await getReferral(owner)).json()).toMatchObject({ via: 'dub', link: null });
    await db.update(organization).set({ referredBy: 'dub' }).where(eq(organization.id, org));
    await expect(
      onReferralEvent({
        provider: 'stripe',
        contour: 'en',
        eventId: 'evt_2',
        type: 'payment.succeeded',
        orgId: org,
        occurredAt: new Date().toISOString(),
        amount: 2900,
        currency: 'USD',
      }),
    ).resolves.toBeUndefined();
  });
});
