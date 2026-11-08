import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { aiCalls, aiProviders, auditLog, subscriptions, user, withOrg } from '@app/db';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { signUp as codeSignUp } from './sign-in.ts';
import { auth } from '../src/auth.ts';
import { billingPeriod, entitlementsOf, type Subscription } from '../src/billing/entitlements.ts';
import { plans } from '../src/billing/plans.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { costCurrency } from '../src/routes/billing.ts';
import { billingWorkflowId, closeTemporal, temporal } from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
type User = { id: string; cookie: string };

const signUp = () => codeSignUp(app);
const call = (
  user: User,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) =>
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

  it('config is consistent with the AI model registry and the contours', () => {
    const models = JSON.parse(
      readFileSync(new URL('../../../config/ai-models.json', import.meta.url), 'utf8'),
    );
    const costCurrencies = new Set<string>(
      Object.values(models.contours as Record<string, Parameters<typeof costCurrency>[0][]>)
        .flat()
        .flatMap((m) => costCurrency(m) ?? []),
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
          // Stripe charges a price object.
          if (c.provider === 'stripe') expect(price!.providerPriceId).toBeTruthy();
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

  it('applies the project limit to API key requests, in the org of the key', async () => {
    const { owner, org } = await ownerWithOrg();
    const created = await call(owner, 'POST', '/api/api-keys', {
      name: 'ci',
      scopes: ['projects:write'],
      expiresInDays: null,
    });
    expect(created.statusCode, created.body).toBe(201);
    const withKey = (name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/projects',
        remoteAddress: ip(),
        headers: { authorization: `Bearer ${created.json().key}` },
        payload: { name },
      });
    for (const name of ['a', 'b', 'c']) expect((await withKey(name)).statusCode).toBe(201);
    const blocked = await withKey('d');
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json()).toEqual({ error: 'plan limit reached: projects' });
    await subscribe(org);
    expect((await withKey('d')).statusCode).toBe(201);
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
      (await call(owner, 'POST', '/api/billing/checkout', { planId: 'pro', currency: 'GBP' }))
        .statusCode,
    ).toBe(400); // not a currency of the en contour
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

describe('organization-owned AI providers (BYO)', () => {
  // The flag override list and the contour are read per request: switch them for this block.
  const contour = env.AI_CONTOUR;
  const withFlag = (on: boolean) => {
    env.FLAGS_ON.splice(0, env.FLAGS_ON.length, ...(on ? ['byo-llm-providers'] : []));
  };
  beforeAll(() => {
    withFlag(true);
    env.AI_CONTOUR = 'ru'; // lists the custom openai_compatible endpoint
  });
  afterAll(() => {
    withFlag(false);
    env.AI_CONTOUR = contour;
  });
  const custom = {
    name: 'On-prem',
    provider: 'openai_compatible',
    baseUrl: 'https://llm.example.com/v1',
    apiKey: 'sk-local-dev-byo-secret-1234',
    models: { 'project.summary': 'example-model' },
  };

  it('needs the byoLlm plan feature and an admin', async () => {
    const { owner, org } = await ownerWithOrg();
    expect((await call(owner, 'POST', '/api/ai-providers', custom)).statusCode).toBe(402);
    await subscribe(org);
    const m = await signUp();
    await auth.api.addMember({ body: { userId: m.id, organizationId: org, role: 'member' } });
    await call(m, 'POST', '/api/auth/organization/set-active', { organizationId: org });
    expect((await call(m, 'GET', '/api/ai-providers')).statusCode).toBe(403);
    expect((await call(owner, 'POST', '/api/ai-providers', custom)).statusCode).toBe(201);
  });

  it('stores the key encrypted, never returns it, and audit-logs changes', async () => {
    const { owner, org } = await ownerWithOrg();
    await subscribe(org);
    const created = await call(owner, 'POST', '/api/ai-providers', custom);
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ kind: 'custom', apiKeyHint: '1234', enabled: true });
    expect(JSON.stringify(body)).not.toContain(custom.apiKey);
    const [row] = await withOrg(db, org, (tx) => tx.select().from(aiProviders));
    expect(row!.apiKey).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(row!.apiKey).not.toContain(custom.apiKey);

    const listed = await call(owner, 'GET', '/api/ai-providers');
    expect(JSON.stringify(listed.json())).not.toContain('sk-local-dev');
    const patched = await call(owner, 'PATCH', `/api/ai-providers/${body.id}`, {
      apiKey: 'sk-local-dev-rotated-5678',
      enabled: false,
    });
    expect(patched.json()).toMatchObject({ apiKeyHint: '5678', enabled: false });
    // The stored key is never sent to a new endpoint without entering it again.
    const moved = await call(owner, 'PATCH', `/api/ai-providers/${body.id}`, {
      baseUrl: 'https://evil.example.com/v1',
    });
    expect(moved.statusCode).toBe(400);
    expect((await call(owner, 'DELETE', `/api/ai-providers/${body.id}`)).statusCode).toBe(204);
    const audit = await withOrg(db, org, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.target, body.id)),
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      'DELETE /api/ai-providers/:id',
      'PATCH /api/ai-providers/:id',
      'POST /api/ai-providers',
    ]);
  });

  it('validates the shape and isolates organizations', async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    await subscribe(a.org);
    await subscribe(b.org);
    const bad = async (payload: object) =>
      (await call(a.owner, 'POST', '/api/ai-providers', { ...custom, ...payload })).statusCode;
    expect(await bad({ baseUrl: null })).toBe(400); // custom without a base URL
    expect(await bad({ provider: 'anthropic' })).toBe(400); // vendor with a base URL
    expect(await bad({ provider: 'claude_cli', baseUrl: null })).toBe(400); // not BYO-able
    expect(await bad({ baseUrl: 'https://user:pw@llm.example.com' })).toBe(400);
    expect(await bad({ models: { 'contract.review': 'x' } })).toBe(400);
    expect(await bad({ provider: 'anthropic', baseUrl: null, apiKey: undefined })).toBe(400);

    const own = (await call(a.owner, 'POST', '/api/ai-providers', custom)).json();
    expect((await call(b.owner, 'GET', '/api/ai-providers')).json()).toEqual([]);
    const other = await call(b.owner, 'PATCH', `/api/ai-providers/${own.id}`, { enabled: false });
    expect(other.statusCode).toBe(404);
    expect((await call(b.owner, 'DELETE', `/api/ai-providers/${own.id}`)).statusCode).toBe(404);
    const options = (await call(a.owner, 'GET', '/api/ai-providers/options')).json();
    expect(options.purposes).toContain('project.summary');
    expect(options.purposes).not.toContain('judge');
    expect(options.providers.map((p: { id: string }) => p.id)).not.toContain('claude_cli');
  });

  it('offers and accepts only providers the contour lists', async () => {
    const { owner, org } = await ownerWithOrg();
    await subscribe(org);
    const ids = async () =>
      (await call(owner, 'GET', '/api/ai-providers/options'))
        .json()
        .providers.map((p: { id: string }) => p.id);
    const anthropic = { ...custom, provider: 'anthropic', baseUrl: null };
    expect(await ids()).toEqual(['openai_compatible']);
    expect((await call(owner, 'POST', '/api/ai-providers', anthropic)).statusCode).toBe(400);
    env.AI_CONTOUR = 'eu'; // lists anthropic, not openai_compatible or openrouter
    try {
      expect(await ids()).toEqual(['anthropic']);
      expect((await call(owner, 'POST', '/api/ai-providers', custom)).statusCode).toBe(400);
      const openrouter = { ...anthropic, provider: 'openrouter' };
      expect((await call(owner, 'POST', '/api/ai-providers', openrouter)).statusCode).toBe(400);
      expect((await call(owner, 'POST', '/api/ai-providers', anthropic)).statusCode).toBe(201);
    } finally {
      env.AI_CONTOUR = 'ru';
    }
  });

  it('is not there (404) while the byo-llm-providers flag is off', async () => {
    const { owner, org } = await ownerWithOrg();
    await subscribe(org);
    const created = (await call(owner, 'POST', '/api/ai-providers', custom)).json();
    withFlag(false);
    try {
      expect((await call(owner, 'GET', '/api/ai-providers')).statusCode).toBe(404);
      expect((await call(owner, 'GET', '/api/ai-providers/options')).statusCode).toBe(404);
      expect((await call(owner, 'POST', '/api/ai-providers', custom)).statusCode).toBe(404);
      const patch = await call(owner, 'PATCH', `/api/ai-providers/${created.id}`, {
        enabled: false,
      });
      expect(patch.statusCode).toBe(404);
      expect((await call(owner, 'DELETE', `/api/ai-providers/${created.id}`)).statusCode).toBe(404);
    } finally {
      withFlag(true);
    }
    expect((await call(owner, 'GET', '/api/ai-providers')).json()).toHaveLength(1);
  });
});
