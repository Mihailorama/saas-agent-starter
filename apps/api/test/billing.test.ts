import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { aiCalls, auditLog, subscriptions, withOrg } from '@app/db';
import Stripe from 'stripe';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { auth } from '../src/auth.ts';
import { billingPeriod, entitlementsOf, type Subscription } from '../src/billing/entitlements.ts';
import { addInterval, plans } from '../src/billing/plans.ts';
import { WebhookRejected } from '../src/billing/provider.ts';
import { yookassaProvider } from '../src/billing/yookassa.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { billingWorkflowId, closeTemporal, temporal } from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
type User = { id: string; cookie: string };

async function signUp(): Promise<User> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    remoteAddress: ip(),
    headers: { origin },
    payload: { email: `${randomUUID()}@example.com`, password: 'correct-horse-battery', name: 'T' },
  });
  expect(res.statusCode).toBe(200);
  return {
    id: res.json().user.id,
    cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
  };
}
const call = (user: User, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, cookie: user.cookie },
    ...(payload && { payload }),
  });
async function ownerWithOrg() {
  const owner = await signUp();
  const res = await call(owner, 'POST', '/api/auth/organization/create', {
    name: 'Org',
    slug: randomUUID(),
  });
  return { owner, org: res.json().id as string };
}
const DAY = 86_400_000;
/** Puts an org on a paid plan the way the worker does after a provider event. */
const subscribe = (orgId: string, over: Partial<typeof subscriptions.$inferInsert> = {}) =>
  withOrg(db, orgId, (tx) =>
    tx.insert(subscriptions).values({
      orgId,
      planId: 'pro',
      status: 'active',
      contour: 'en',
      provider: 'stripe',
      currency: 'USD',
      customerId: 'cus_123',
      providerSubscriptionId: 'sub_123',
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 29 * DAY),
      ...over,
    }),
  );
const spend = (orgId: string, cost: number, createdAt = new Date()) =>
  withOrg(db, orgId, (tx) =>
    tx.insert(aiCalls).values({
      orgId,
      purpose: 'project.summary',
      provider: 'anthropic',
      requestModel: 'claude-haiku-5-5',
      promptTemplateId: 'project.summary',
      promptTemplateVersion: '1',
      requestKey: `${orgId}/x/request.json`,
      contentExpiresAt: new Date(Date.now() + DAY),
      cost,
      costCurrency: 'USD',
      latencyMs: 1,
      status: 'ok',
      contour: 'eu',
      createdAt,
    }),
  );

const terminate: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const id of terminate.splice(0)) {
    await (await temporal()).workflow
      .getHandle(id)
      .terminate('test cleanup')
      .catch(() => {});
  }
});
afterAll(async () => {
  await app.close();
  await closeTemporal();
  await pool.end();
});

describe('plans and entitlements', () => {
  const sub = (over: Partial<Subscription>): Subscription => ({
    orgId: 'o',
    planId: 'pro',
    status: 'active',
    contour: 'en',
    provider: 'stripe',
    currency: 'USD',
    customerId: null,
    providerSubscriptionId: null,
    paymentMethodId: null,
    currentPeriodStart: new Date('2026-11-10T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-10T00:00:00Z'),
    cancelAtPeriodEnd: false,
    llmSpendLimits: null,
    lastEventAt: null,
    updatedAt: new Date(),
    ...over,
  });
  const now = new Date('2026-11-20T00:00:00Z');

  it('maps a subscription to its plan, period and limits', () => {
    expect(entitlementsOf(null, now)).toMatchObject({
      planId: 'free',
      limits: { seats: 3, projects: 3 },
      period: { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') },
    });
    expect(entitlementsOf(sub({}), now)).toMatchObject({
      planId: 'pro',
      period: { start: new Date('2026-11-10T00:00:00Z') },
    });
    expect(entitlementsOf(sub({ status: 'past_due' }), now).planId).toBe('pro'); // grace
    const lapsed = sub({ status: 'past_due', currentPeriodEnd: new Date('2026-11-12T00:00:00Z') });
    expect(entitlementsOf(lapsed, now).planId).toBe('free'); // pastDueGraceDays (7) are over
    expect(entitlementsOf(sub({ status: 'canceled' }), now).planId).toBe('free');
    expect(entitlementsOf(sub({ status: 'incomplete' }), now).planId).toBe('free');
    expect(entitlementsOf(sub({ planId: 'removed-plan' }), now).planId).toBe('free');
    // A paid period that has run out falls back to the calendar month.
    expect(billingPeriod(sub({}), new Date('2026-12-15T00:00:00Z')).start).toEqual(
      new Date('2026-12-01T00:00:00Z'),
    );
  });

  it('applies raised LLM limits only within the plan', () => {
    expect(entitlementsOf(sub({ llmSpendLimits: { USD: 50 } })).llmSpendLimit('USD')).toBe(50);
    expect(entitlementsOf(sub({ llmSpendLimits: { USD: 10_000 } })).llmSpendLimit('USD')).toBe(200);
    const free = sub({ planId: 'free', llmSpendLimits: { USD: 50 } });
    expect(entitlementsOf(free).llmSpendLimit('USD')).toBe(1);
  });

  it('adds billing intervals without month overflow', () => {
    expect(addInterval(new Date('2026-01-31T12:00:00Z'), 'month')).toEqual(
      new Date('2026-02-28T12:00:00Z'),
    );
    expect(addInterval(new Date('2028-02-29T00:00:00Z'), 'year')).toEqual(
      new Date('2029-02-28T00:00:00Z'),
    );
  });

  it('config is consistent with the AI model registry and the contours', () => {
    const models = JSON.parse(
      readFileSync(new URL('../../../config/ai-models.json', import.meta.url), 'utf8'),
    );
    const costCurrencies = new Set<string>(
      Object.values(
        models.contours as Record<string, { pricePer1kTokens: { currency: string } | null }[]>,
      )
        .flat()
        .flatMap((m) => (m.pricePer1kTokens ? [m.pricePer1kTokens.currency] : [])),
    );
    for (const [id, plan] of Object.entries(plans.plans)) {
      for (const cur of costCurrencies) {
        expect(plan.limits.llmSpendMonthly[cur], `${id} LLM limit in ${cur}`).toBeDefined();
        expect(plan.llmSpendMax[cur]! >= plan.limits.llmSpendMonthly[cur]!).toBe(true);
      }
      if (id === plans.defaultPlan) continue;
      for (const c of Object.values(plans.contours)) {
        for (const cur of c.currencies) {
          const price = plan.prices[cur];
          expect(price, `${id} price in ${cur}`).toBeDefined();
          // Stripe charges a price object; YooKassa takes the amount per payment.
          expect(Boolean(price!.providerPriceId)).toBe(c.provider === 'stripe');
        }
      }
    }
  });
});

describe('entitlement guard', () => {
  it('blocks project creation at the plan limit, lifts it on upgrade', async () => {
    const { owner, org } = await ownerWithOrg();
    for (const name of ['a', 'b', 'c']) {
      expect((await call(owner, 'POST', '/api/projects', { name })).statusCode).toBe(201);
    }
    const blocked = await call(owner, 'POST', '/api/projects', { name: 'd' });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json()).toEqual({ error: 'plan limit reached: projects' });

    await subscribe(org);
    expect((await call(owner, 'POST', '/api/projects', { name: 'd' })).statusCode).toBe(201);
  });

  it('limits seats to the plan', async () => {
    const { org } = await ownerWithOrg();
    for (let i = 0; i < 2; i++) {
      const u = await signUp();
      await auth.api.addMember({ body: { userId: u.id, organizationId: org, role: 'member' } });
    }
    const fourth = await signUp();
    await expect(
      auth.api.addMember({ body: { userId: fourth.id, organizationId: org, role: 'member' } }),
    ).rejects.toThrow(/membership limit/i);
  });

  it('lets admins raise the LLM limit only where the plan allows it', async () => {
    const { owner, org } = await ownerWithOrg();
    const raise = (amount: number) =>
      call(owner, 'PATCH', '/api/billing/llm-limit', { currency: 'USD', amount });
    expect((await raise(5)).statusCode).toBe(402); // free plan: feature not included

    await subscribe(org);
    expect((await raise(201)).statusCode).toBe(400); // above llmSpendMax
    expect((await raise(50)).statusCode).toBe(204);
    const billing = (await call(owner, 'GET', '/api/billing')).json();
    expect(billing.llmSpend).toEqual([
      { currency: 'USD', spent: 0, limit: 50, max: 200, level: 'ok' },
    ]);
  });
});

describe('billing page data', () => {
  it('reports plan, usage and LLM spend vs. limit with warning and block levels', async () => {
    const { owner, org } = await ownerWithOrg();
    const read = async () => (await call(owner, 'GET', '/api/billing')).json();

    const fresh = await read();
    expect(fresh).toMatchObject({
      planId: 'free',
      status: null,
      provider: 'stripe',
      currency: 'USD',
      canManage: true,
      usage: { seats: { used: 1, limit: 3 }, projects: { used: 0, limit: 3 } },
      llmSpend: [{ currency: 'USD', spent: 0, limit: 1, level: 'ok' }],
    });
    // Prices come from config/plans.json, per currency.
    expect(fresh.plans).toEqual([
      expect.objectContaining({ id: 'free', price: null }),
      expect.objectContaining({ id: 'pro', price: { amount: '29.00', interval: 'month' } }),
    ]);

    await spend(org, 0.85);
    expect((await read()).llmSpend[0]).toMatchObject({ spent: 0.85, level: 'warning' });
    await spend(org, 0.15);
    expect((await read()).llmSpend[0]).toMatchObject({ spent: 1, level: 'blocked' });
    // Spend from before the period does not count (ai_calls is append-only: new org).
    const { owner: o2, org: org2 } = await ownerWithOrg();
    await spend(org2, 5, new Date(Date.now() - 40 * DAY));
    const old = (await call(o2, 'GET', '/api/billing')).json();
    expect(old.llmSpend[0]).toMatchObject({ spent: 0, level: 'ok' });
  });

  it('is tenant-isolated and needs a session', async () => {
    const { org } = await ownerWithOrg();
    await subscribe(org);
    const { owner: other } = await ownerWithOrg();
    expect((await call(other, 'GET', '/api/billing')).json().planId).toBe('free');
    const anon = await app.inject({ url: '/api/billing', remoteAddress: ip() });
    expect(anon.statusCode).toBe(401);
  });
});

describe('Stripe (stripe-mock)', () => {
  it('creates checkout and portal sessions and cancels at period end', async () => {
    const { owner, org } = await ownerWithOrg();
    const checkout = await call(owner, 'POST', '/api/billing/checkout', { planId: 'pro' });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(
      (await call(owner, 'POST', '/api/billing/checkout', { planId: 'free' })).statusCode,
    ).toBe(400);
    expect(
      (await call(owner, 'POST', '/api/billing/checkout', { planId: 'pro', currency: 'RUB' }))
        .statusCode,
    ).toBe(400); // RUB is sold in the ru contour only
    expect((await call(owner, 'POST', '/api/billing/portal')).statusCode).toBe(404);

    await subscribe(org);
    expect((await call(owner, 'POST', '/api/billing/checkout', { planId: 'pro' })).statusCode).toBe(
      409,
    );
    const portal = await call(owner, 'POST', '/api/billing/portal');
    expect(portal.statusCode).toBe(200);
    expect(portal.json().url).toMatch(/^https:\/\//);
    expect((await call(owner, 'POST', '/api/billing/cancel')).statusCode).toBe(204);
    expect((await call(owner, 'GET', '/api/billing')).json().cancelAtPeriodEnd).toBe(true);

    const audit = await withOrg(db, org, (tx) => tx.select().from(auditLog));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['POST /api/billing/checkout', 'POST /api/billing/cancel']),
    );
  });

  it('only admins manage billing', async () => {
    const { org } = await ownerWithOrg();
    const m = await signUp();
    await auth.api.addMember({ body: { userId: m.id, organizationId: org, role: 'member' } });
    await call(m, 'POST', '/api/auth/organization/set-active', { organizationId: org });
    expect((await call(m, 'GET', '/api/billing')).json().canManage).toBe(false);
    expect((await call(m, 'POST', '/api/billing/checkout', { planId: 'pro' })).statusCode).toBe(
      403,
    );
  });

  // stripe-mock does not send webhooks: sign fixture events with the SDK's test helper.
  const url = new URL(env.STRIPE_API_URL!);
  const stripe = new Stripe('sk_test_123', {
    host: url.hostname,
    port: url.port,
    protocol: 'http',
  });
  const deliver = async (event: object, secret = env.STRIPE_WEBHOOK_SECRET!) => {
    const payload = JSON.stringify(event);
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
    return app.inject({
      method: 'POST',
      url: '/api/billing/webhooks/stripe',
      remoteAddress: ip(),
      headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': signature },
      payload,
    });
  };

  it('verifies signed webhooks and starts one workflow per event', async () => {
    const orgId = randomUUID();
    const fixture = await stripe.subscriptions.retrieve('sub_123'); // realistic object shape
    const id = `evt_${randomUUID().replaceAll('-', '')}`;
    const event = {
      id,
      object: 'event',
      type: 'customer.subscription.created',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          ...fixture,
          status: 'active',
          metadata: { orgId, planId: 'pro' },
          items: {
            ...fixture.items,
            data: [
              {
                ...fixture.items.data[0]!,
                price: { ...fixture.items.data[0]!.price, id: 'price_example_pro_usd' },
              },
            ],
          },
        },
      },
    };
    const workflowId = billingWorkflowId({ provider: 'stripe', eventId: id });
    terminate.push(workflowId);

    const res = await deliver(event);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ received: 1 });
    const handle = (await temporal()).workflow.getHandle(workflowId);
    const first = await handle.describe();
    expect(first.type).toBe('BillingEventWorkflow');
    // Redelivery: accepted, but no second execution.
    expect((await deliver(event)).statusCode).toBe(200);
    expect((await handle.describe()).runId).toBe(first.runId);

    expect((await deliver(event, 'whsec_wrong')).statusCode).toBe(400);
    const unsigned = await app.inject({
      method: 'POST',
      url: '/api/billing/webhooks/stripe',
      remoteAddress: ip(),
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(event),
    });
    expect(unsigned.statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/billing/webhooks/paypal', payload: '{}' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('YooKassa (recorded fixtures)', () => {
  const fixture = (name: string, orgId: string) =>
    JSON.parse(
      readFileSync(new URL(`fixtures/yookassa/${name}.json`, import.meta.url), 'utf8').replaceAll(
        '{{orgId}}',
        orgId,
      ),
    );
  /** fetch stand-in that records requests and answers with a fixture. */
  const fakeApi = (reply: object) => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    return { sent, fn };
  };
  const provider = (fn: typeof fetch) =>
    yookassaProvider({
      contour: 'ru',
      shopId: 'local-dev-shop',
      secretKey: 'local_dev_yookassa_secret',
      apiUrl: 'https://api.yookassa.example.com/v3',
      fetch: fn,
    });
  const YOOKASSA_IP = '185.71.76.10';

  it('creates a payment that saves the payment method and redirects to confirmation', async () => {
    const orgId = randomUUID();
    const api = fakeApi(fixture('payment-pending', orgId));
    const { url } = await provider(api.fn).checkout({
      orgId,
      planId: 'pro',
      planName: 'Pro',
      currency: 'RUB',
      price: plans.plans.pro!.prices.RUB!,
      customerId: null,
      returnUrl: 'https://app.example.com/settings/billing',
    });
    expect(url).toMatch(/^https:\/\/yoomoney\.ru\/checkout\//);
    const [req] = api.sent;
    expect(req!.url).toBe('https://api.yookassa.example.com/v3/payments');
    const headers = req!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('local-dev-shop:local_dev_yookassa_secret').toString('base64')}`,
    );
    expect(headers['idempotence-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(req!.init.body as string)).toEqual({
      amount: { value: '2490.00', currency: 'RUB' },
      capture: true,
      save_payment_method: true,
      confirmation: {
        type: 'redirect',
        return_url: 'https://app.example.com/settings/billing?checkout=success',
      },
      description: 'Pro subscription',
      metadata: { orgId, planId: 'pro', kind: 'initial' },
    });
  });

  it('trusts a notification only from YooKassa IPs and after re-reading the payment', async () => {
    const orgId = randomUUID();
    const api = fakeApi(fixture('payment-succeeded', orgId));
    const body = JSON.stringify(fixture('notification-succeeded', orgId));
    const yk = provider(api.fn);

    await expect(yk.webhook({ body, headers: {}, ip: '203.0.113.7' })).rejects.toThrow(
      WebhookRejected,
    );
    await expect(yk.webhook({ body: 'not json', headers: {}, ip: YOOKASSA_IP })).rejects.toThrow(
      WebhookRejected,
    );
    expect(api.sent).toHaveLength(0);

    const events = await yk.webhook({ body, headers: {}, ip: `::ffff:${YOOKASSA_IP}` });
    expect(api.sent.map((r) => [r.init.method, r.url])).toEqual([
      ['GET', 'https://api.yookassa.example.com/v3/payments/2f1b2c3d-000f-5000-8000-1a2b3c4d5e6f'],
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: 'payment.succeeded', orgId, provider: 'yookassa' }),
      expect.objectContaining({
        type: 'subscription.activated',
        eventId: '2f1b2c3d-000f-5000-8000-1a2b3c4d5e6f.subscription',
        orgId,
        contour: 'ru',
        planId: 'pro',
        currency: 'RUB',
        paymentMethodId: '2f1b2c3d-000f-5000-8000-1a2b3c4d5e6f',
        periodStart: '2026-11-01T10:01:30.000Z',
        periodEnd: '2026-12-01T10:01:30.000Z',
      }),
    ]);

    // The notification claims success but the API says otherwise: ignored.
    const pending = provider(fakeApi(fixture('payment-pending', orgId)).fn);
    expect(await pending.webhook({ body, headers: {}, ip: YOOKASSA_IP })).toEqual([]);
  });

  it('maps a failed renewal to payment.failed and past_due', async () => {
    const orgId = randomUUID();
    const payment = fixture('payment-renewal-canceled', orgId);
    const body = JSON.stringify({
      type: 'notification',
      event: 'payment.canceled',
      object: payment,
    });
    const events = await provider(fakeApi(payment).fn).webhook({
      body,
      headers: {},
      ip: YOOKASSA_IP,
    });
    expect(events.map((e) => e.type)).toEqual(['payment.failed', 'subscription.past_due']);
  });

  it('webhook route starts the workflows', async () => {
    const orgId = randomUUID();
    vi.stubGlobal('fetch', fakeApi(fixture('payment-succeeded', orgId)).fn);
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/webhooks/yookassa',
      remoteAddress: YOOKASSA_IP,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(fixture('notification-succeeded', orgId)),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ received: 2 });
    for (const suffix of ['succeeded', 'subscription']) {
      const id = billingWorkflowId({
        provider: 'yookassa',
        eventId: `2f1b2c3d-000f-5000-8000-1a2b3c4d5e6f.${suffix}`,
      });
      terminate.push(id);
      expect((await (await temporal()).workflow.getHandle(id).describe()).type).toBe(
        'BillingEventWorkflow',
      );
    }
    const forged = await app.inject({
      method: 'POST',
      url: '/api/billing/webhooks/yookassa',
      remoteAddress: '203.0.113.7',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(fixture('notification-succeeded', orgId)),
    });
    expect(forged.statusCode).toBe(400);
  });
});
