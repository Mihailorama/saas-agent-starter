// Pricing models (docs/billing.md "Pricing models") on config/plans.examples.json: config shape,
// entitlements per model, Stripe line items (stripe-mock), and the manual contract provider.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditLog, subscriptions, user, withOrg } from '@app/db';
import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Plans and the operator list are read once at import: set them before the app loads.
const examples = new URL('../../../config/plans.examples.json', import.meta.url);
process.env.PLANS_FILE = fileURLToPath(examples);
const opEmail = `op-${randomUUID()}@example.com`;
process.env.OPERATOR_EMAILS = opEmail;
const { buildApp } = await import('../src/app.ts');
const { db, pool } = await import('../src/db.ts');
const { allowedOrigins } = await import('../src/env.ts');
const { closeTemporal, temporal } = await import('../src/temporal.ts');
const { parsePlans, plans } = await import('../src/billing/plans.ts');
const { entitlementsOf } = await import('../src/billing/entitlements.ts');
const { lineItems } = await import('../src/billing/stripe.ts');

const app = await buildApp();
const origin = allowedOrigins[0]!;
const password = 'correct-horse-battery';
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
type User = { id: string; cookie: string };

const call = (u: User, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, cookie: u.cookie },
    ...(payload && { payload }),
  });
async function signUp(email = `${randomUUID()}@example.com`): Promise<User> {
  const body = { email, password, name: 'T' };
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    remoteAddress: ip(),
    headers: { origin },
    payload: body,
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
async function ownerWithOrg() {
  const owner = await signUp();
  const res = await call(owner, 'POST', '/api/auth/organization/create', {
    name: 'Org',
    slug: randomUUID(),
  });
  return { owner, org: res.json().id as string };
}

const started: string[] = [];
let op: User;
beforeAll(async () => {
  op = await signUp(opEmail);
  const { totpURI } = (await call(op, 'POST', '/api/auth/two-factor/enable', { password })).json();
  const code = (OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP).generate();
  const verified = await call(op, 'POST', '/api/auth/two-factor/verify-totp', { code });
  const jar = new Map(op.cookie.split('; ').map((c) => c.split('=', 2) as [string, string]));
  for (const c of verified.cookies) jar.set(c.name, c.value); // the session is re-issued
  op.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}, 20_000);
afterAll(async () => {
  for (const id of started) {
    await (await temporal()).workflow
      .getHandle(id)
      .terminate('test cleanup')
      .catch(() => {});
  }
  await app.close();
  await closeTemporal();
  await pool.end();
});

describe('price models in config', () => {
  const doc = JSON.parse(readFileSync(examples, 'utf8'));
  const withPrice = (price: unknown) =>
    JSON.stringify({
      ...doc,
      plans: { ...doc.plans, x: { ...doc.plans.starter, prices: { USD: price } } },
    });

  it('parses every model; a price without `model` is flat (the shipped plans.json)', () => {
    expect(plans.plans.growth!.prices.USD!.map((c) => c.model)).toEqual(['flat', 'metered']);
    const legacy = { amount: '1.00', interval: 'month', providerPriceId: 'price_1' };
    expect(parsePlans(withPrice(legacy)).plans.x!.prices.USD).toEqual([
      { model: 'flat', ...legacy },
    ]);
  });

  it('refuses shapes a provider cannot sell', () => {
    const flat = doc.plans.starter.prices.USD;
    const contract = doc.plans.enterprise.prices.USD;
    const pack = doc.plans.prepaid.prices.USD[1];
    expect(() => parsePlans(withPrice([flat, flat]))).toThrow(/at most one flat or per_seat/);
    expect(() => parsePlans(withPrice([flat, contract]))).toThrow(/contract price stands alone/);
    expect(() => parsePlans(withPrice([flat, pack]))).toThrow(/need a metered component/);
    expect(() => parsePlans(withPrice({ ...flat, model: 'barter' }))).toThrow();
  });
});

describe('entitlements and line items per model', () => {
  const sub = (planId: string, over: object = {}) => ({
    orgId: 'o',
    planId,
    status: 'active' as const,
    contour: 'en',
    provider: 'stripe',
    currency: 'USD',
    customerId: null,
    providerSubscriptionId: null,
    currentPeriodStart: new Date(Date.now() - 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
    cancelAtPeriodEnd: false,
    llmSpendLimits: null,
    lastEventAt: null,
    updatedAt: new Date(),
    seats: 7,
    contractRef: null,
    ...over,
  });

  it('per seat: the purchased quantity is the seat limit, an operator override wins', () => {
    expect(entitlementsOf(sub('team'))).toMatchObject({
      models: ['per_seat'],
      limits: { seats: 7 },
    });
    expect(entitlementsOf(sub('team'), new Date(), { seats: 9 }).limits.seats).toBe(9);
    expect(entitlementsOf(sub('starter')).limits.seats).toBe(5); // flat: the plan's limit
    expect(entitlementsOf(null).models).toEqual([]);
  });

  it('Stripe line items: metered without quantity, per seat with the members', () => {
    expect(lineItems(plans.plans.growth!.prices.USD!, 3)).toEqual([
      { price: 'price_example_growth_base_usd', quantity: 1 },
      { price: 'price_example_growth_api_usd' },
    ]);
    expect(lineItems(plans.plans.team!.prices.USD!, 4)).toEqual([
      { price: 'price_example_team_seat_usd', quantity: 4 },
    ]);
  });
});

describe('checkout per model (stripe-mock)', () => {
  it('sells flat, per-seat, metered and hybrid plans; contracts and packs go elsewhere', async () => {
    const { owner } = await ownerWithOrg();
    const billing = (await call(owner, 'GET', '/api/billing')).json();
    const sold = Object.fromEntries(
      billing.plans.map((p: { id: string; checkout: boolean }) => [p.id, p.checkout]),
    );
    expect(sold).toMatchObject({
      free: false,
      starter: true,
      team: true,
      payg: true,
      growth: true,
      prepaid: false, // Stripe sells credit packs only once credit grants are on (PR 3)
      enterprise: false,
      'enterprise-invoiced': false,
    });
    for (const planId of ['starter', 'team', 'payg', 'growth']) {
      const res = await call(owner, 'POST', '/api/billing/checkout', { planId });
      expect(res.statusCode, `${planId}: ${res.body}`).toBe(200);
    }
    const contract = await call(owner, 'POST', '/api/billing/checkout', { planId: 'enterprise' });
    expect(contract.statusCode).toBe(400);
  });
});

describe('contracts (operator console)', () => {
  const put = (orgId: string, body: object) =>
    call(op, 'PUT', `/api/admin/orgs/${orgId}/contract`, { reason: 'signed order form', ...body });
  const start = new Date();
  const end = new Date(Date.now() + 365 * 86_400_000);

  it('manual: sets plan, period and reference, audited, with a timer to the period end', async () => {
    const { owner, org } = await ownerWithOrg();
    const contract = {
      planId: 'enterprise',
      currency: 'USD',
      contractRef: 'PO-4711',
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    };
    expect((await put(org, { ...contract, planId: 'starter' })).statusCode).toBe(400);
    expect((await put(org, { ...contract, periodEnd: undefined })).statusCode).toBe(400);
    const asOwner = { ...contract, reason: 'not an operator' };
    expect((await call(owner, 'PUT', `/api/admin/orgs/${org}/contract`, asOwner)).statusCode).toBe(
      403,
    );
    const res = await put(org, contract);
    expect(res.statusCode, res.body).toBe(204);
    const workflowId = `billing-contract-${org}-${end.getTime()}`;
    started.push(workflowId);
    expect((await (await temporal()).workflow.getHandle(workflowId).describe()).type).toBe(
      'ContractPeriodWorkflow',
    );

    const billing = (await call(owner, 'GET', '/api/billing')).json();
    expect(billing).toMatchObject({ planId: 'enterprise', provider: 'manual', status: 'active' });
    expect(billing.usage.seats.limit).toBe(100);
    const [row] = await withOrg(db, org, (tx) => tx.select().from(subscriptions));
    expect(row).toMatchObject({
      provider: 'manual',
      contractRef: 'PO-4711',
      currentPeriodEnd: end,
    });
    const audit = await withOrg(db, org, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'operator.contract.set')),
    );
    expect(audit).toMatchObject([
      {
        actorId: op.id,
        reason: 'signed order form',
        target: `enterprise PO-4711 until ${end.toISOString()}`,
      },
    ]);
    // Nothing self-serve on a contract: no portal, no cancel button, no checkout.
    expect((await call(owner, 'POST', '/api/billing/portal')).statusCode).toBe(404);
    expect((await call(owner, 'POST', '/api/billing/cancel')).statusCode).toBe(409);
    const detail = (await call(op, 'GET', `/api/admin/orgs/${org}`)).json();
    expect(detail.subscription).toMatchObject({ contractRef: 'PO-4711', dashboardUrl: null });
    expect(detail.contractPlans.map((p: { id: string }) => p.id)).toEqual([
      'enterprise',
      'enterprise-invoiced',
    ]);
  });

  it('Stripe: a send_invoice subscription for bank-transfer contracts', async () => {
    const { org } = await ownerWithOrg();
    const res = await put(org, {
      planId: 'enterprise-invoiced',
      currency: 'USD',
      contractRef: 'PO-1',
    });
    expect(res.statusCode, res.body).toBe(204);
    const audit = await withOrg(db, org, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'operator.contract.invoiced')),
    );
    expect(audit).toHaveLength(1);
  });
});
