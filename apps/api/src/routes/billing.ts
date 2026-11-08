import { readFileSync } from 'node:fs';
import { member, projects, subscriptions, type Tx, withOrg } from '@app/db';
import { count, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  type Entitlements,
  entitlements,
  llmSpend,
  requireEntitlement,
  type Subscription,
} from '../billing/entitlements.ts';
import { contour, type Price, plans, subscribable } from '../billing/plans.ts';
import { NotSupported, ProviderNotConfigured, WebhookRejected } from '../billing/provider.ts';
import { contourOfProvider, providerFor, providerOf } from '../billing/registry.ts';
import { db } from '../db.ts';
import { env } from '../env.ts';
import { isEnabled } from '../flags.ts';
import { startBillingEvent } from '../temporal.ts';
import { httpError, requireRole, withTenant } from '../tenant.ts';

/**
 * Cost currencies the LLM spend is shown in: those of the metered models of AI_CONTOUR. A
 * model without an explicit price is priced from LiteLLM's cost map, in USD (worker/ai.py).
 */
const aiModels = JSON.parse(
  readFileSync(new URL('../../../../config/ai-models.json', import.meta.url), 'utf8'),
) as { contours: Record<string, AiModel[]> };
type AiModel = { pricePer1kTokens?: { currency: string } | null; unmetered?: boolean };
export const costCurrency = (m: AiModel) =>
  m.unmetered ? null : (m.pricePer1kTokens?.currency ?? 'USD');
export const costCurrencies = [
  ...new Set((aiModels.contours[env.AI_CONTOUR] ?? []).flatMap((m) => costCurrency(m) ?? [])),
];
/** Soft warning from this share of the limit on; calls are refused at 1 (worker/billing.py). */
export const LLM_WARN_RATIO = 0.8;

const Usage = z.object({ used: z.number(), limit: z.number() });
const Billing = z.object({
  planId: z.string(),
  planName: z.string(),
  status: z.enum(['incomplete', 'active', 'past_due', 'canceled']).nullable(),
  provider: z.string(),
  currency: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  canManage: z.boolean(),
  /** What the subscription's provider offers its customers (a manual contract: neither). */
  selfService: z.object({ portal: z.boolean(), cancel: z.boolean() }),
  /** LLM usage is billed (pay as you go): the limit warns, the org's own cap stops calls. */
  payg: z.boolean(),
  /** Prepaid credits (flag billing-credits): balance in major units, the pack on sale. */
  credits: z
    .object({
      balance: z.number().nullable(),
      pack: z.object({ credits: z.number(), amount: z.string() }),
    })
    .nullable(),
  usage: z.object({ seats: Usage, projects: Usage }),
  llmSpend: z.array(
    z.object({
      currency: z.string(),
      spent: z.number(),
      limit: z.number(),
      max: z.number(),
      level: z.enum(['ok', 'warning', 'blocked']),
    }),
  ),
  features: z.record(z.string(), z.boolean()),
  plans: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      seats: z.number(),
      projects: z.number(),
      llmSpendMonthly: z.number().nullable(),
      /** The flat or per-seat base price, if any. */
      price: z.object({ amount: z.string(), interval: z.string() }).nullable(),
      models: z.array(z.string()),
      /** Sold through the provider's checkout (else: free, or a contract via sales). */
      checkout: z.boolean(),
    }),
  ),
});
const Checkout = z.object({ planId: z.string().min(1), currency: z.string().length(3).optional() });
const LlmLimit = z.object({
  currency: z.string().length(3),
  amount: z.number().nonnegative().max(1e9),
});
const Url = z.object({ url: z.url() });
const ErrorBody = z.object({ error: z.string() });

const currentSubscription = async (tx: Tx) => (await tx.select().from(subscriptions))[0] ?? null;
const basePrice = (price: Price | undefined) =>
  price?.find((c) => c.model === 'flat' || c.model === 'per_seat');
/** Whether the contour's provider sells these components through its checkout. */
function sellable(contourId: string, price: Price | undefined) {
  if (!price || !subscribable(price).length) return false; // free, contract or packs only
  try {
    const caps = providerFor(contourId).capabilities();
    return caps.checkout && price.every((c) => caps.priceModels.includes(c.model));
  } catch {
    return false; // provider not configured here
  }
}

function selfService(sub: Subscription | null) {
  if (!sub) return { portal: false, cancel: false };
  try {
    const caps = providerOf(sub).capabilities();
    return { portal: caps.portal, cancel: caps.cancel };
  } catch {
    return { portal: false, cancel: false };
  }
}

/** The credit pack on sale for the org's plan, if any (flag billing-credits). */
async function packOf(e: Entitlements) {
  const sub = e.subscription;
  const pack = sub && e.plan.prices[sub.currency]?.find((c) => c.model === 'credits');
  if (!sub || !pack || pack.model !== 'credits' || !e.models.includes('credits')) return null;
  if (!(await isEnabled('billing-credits', { userId: sub.orgId, orgId: sub.orgId }))) return null;
  return { sub, pack };
}

async function creditsOf(log: FastifyBaseLogger, e: Entitlements) {
  const found = await packOf(e);
  if (!found) return null;
  let balance: number | null = null;
  try {
    const minor = await providerOf(found.sub).creditBalance?.(found.sub);
    balance = minor === undefined ? null : minor / 100; // ponytail: 2-decimal currencies only
  } catch (err) {
    log.warn({ err }, 'credit balance unavailable'); // the page still renders
  }
  return { balance, pack: { credits: found.pack.pack.credits, amount: found.pack.pack.amount } };
}

/** Maps provider failures to clear errors without leaking provider responses. */
async function viaProvider<T>(log: FastifyBaseLogger, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderNotConfigured) throw httpError(503, 'billing is not configured');
    if (err instanceof NotSupported) throw httpError(409, err.message);
    if ((err as { statusCode?: number }).statusCode) throw err;
    log.error({ err }, 'payment provider call failed');
    throw httpError(502, 'payment provider error');
  }
}

export const billingRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['billing'];
  const admin = { preHandler: requireRole('admin') };
  const returnUrl = `${env.BETTER_AUTH_URL}/settings/billing`;

  app.get(
    '/',
    { preHandler: requireRole('member'), schema: { tags, response: { 200: Billing } } },
    async (req) => {
      const { orgId, rank } = req.tenant;
      return withTenant(req, async (tx) => {
        const e = await entitlements(orgId, tx);
        const sub = e.subscription;
        const contourId = sub?.contour ?? env.BILLING_CONTOUR;
        const c = contour(contourId);
        const currency = sub?.currency ?? c.currencies[0]!;
        const [projectCount] = await tx.select({ n: count() }).from(projects);
        const [seatCount] = await db
          .select({ n: count() })
          .from(member)
          .where(eq(member.organizationId, orgId));
        const spent = await llmSpend(tx, orgId, e.period);
        // Pay as you go (flag billing-usage): over the plan's limit is a warning; calls stop only
        // at the org's own cap, as in the worker's gateway.
        const payg = e.payg && (await isEnabled('billing-usage', { userId: orgId, orgId }));
        return {
          planId: e.planId,
          planName: e.plan.name,
          status: sub?.status ?? null,
          provider: sub?.provider ?? c.provider,
          currency,
          periodStart: e.period.start.toISOString(),
          periodEnd: e.period.end.toISOString(),
          cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
          canManage: rank >= 2,
          selfService: selfService(sub),
          payg,
          credits: await creditsOf(req.log, e),
          usage: {
            seats: { used: seatCount?.n ?? 0, limit: e.limits.seats },
            projects: { used: projectCount?.n ?? 0, limit: e.limits.projects },
          },
          llmSpend: costCurrencies.flatMap((cur) => {
            const limit = e.llmSpendLimit(cur);
            if (limit === undefined) return [];
            const s = spent[cur] ?? 0;
            const cap = payg ? e.llmSpendCap(cur) : limit;
            const level =
              cap !== undefined && s >= cap
                ? 'blocked'
                : s >= limit * LLM_WARN_RATIO
                  ? 'warning'
                  : 'ok';
            const max = e.plan.features.llmLimitRaise ? (e.plan.llmSpendMax[cur] ?? limit) : limit;
            return [{ currency: cur, spent: s, limit, max, level } as const];
          }),
          features: e.features,
          plans: Object.entries(plans.plans)
            .filter(([id, p]) => id === plans.defaultPlan || p.prices[currency])
            .map(([id, p]) => {
              const base = basePrice(p.prices[currency]);
              return {
                id,
                name: p.name,
                seats: p.limits.seats,
                projects: p.limits.projects,
                llmSpendMonthly: p.limits.llmSpendMonthly[costCurrencies[0] ?? currency] ?? null,
                price: base ? { amount: base.amount, interval: base.interval } : null,
                models: (p.prices[currency] ?? []).map((c) => c.model),
                checkout: sellable(contourId, p.prices[currency]),
              };
            }),
        };
      });
    },
  );

  app.post(
    '/checkout',
    {
      ...admin,
      schema: { tags, body: Checkout, response: { 200: Url, 400: ErrorBody, 409: ErrorBody } },
    },
    async (req) => {
      // Provider calls happen outside the DB transaction; the audit row is written after.
      const sub = await withOrg(db, req.tenant.orgId, currentSubscription);
      const contourId = sub?.contour ?? env.BILLING_CONTOUR;
      const currency = req.body.currency ?? sub?.currency ?? contour(contourId).currencies[0]!;
      const plan = plans.plans[req.body.planId];
      const price = plan?.prices[currency];
      if (!plan || !price || !contour(contourId).currencies.includes(currency)) {
        throw httpError(400, 'this plan is not sold in this currency');
      }
      if (!sellable(contourId, price)) {
        throw httpError(400, 'this plan is not sold through checkout: contact sales');
      }
      if (sub && (sub.status === 'active' || sub.status === 'past_due')) {
        throw httpError(409, 'already subscribed: change or cancel the current plan first');
      }
      const [seats] = await db
        .select({ n: count() })
        .from(member)
        .where(eq(member.organizationId, req.tenant.orgId));
      const result = await viaProvider(req.log, () =>
        providerFor(contourId).checkout({
          orgId: req.tenant.orgId,
          planId: req.body.planId,
          planName: plan.name,
          currency,
          prices: subscribable(price),
          seats: seats?.n ?? 1,
          customerId: sub?.customerId ?? null,
          returnUrl,
        }),
      );
      return withTenant(
        req,
        async () => result,
        () => req.body.planId,
      );
    },
  );

  // A prepaid credit pack (docs/billing.md "Prepaid credits"); the worker grants it after payment.
  app.post(
    '/credits/checkout',
    { ...admin, schema: { tags, response: { 200: Url, 409: ErrorBody } } },
    async (req) => {
      const e = await entitlements(req.tenant.orgId);
      const found = await packOf(e);
      const provider = found && providerOf(found.sub);
      if (!found?.sub.customerId || !provider?.topUp) {
        throw httpError(409, 'this plan has no credit packs');
      }
      const result = await viaProvider(req.log, () =>
        provider.topUp!({
          orgId: req.tenant.orgId,
          planId: e.planId,
          currency: found.sub.currency,
          customerId: found.sub.customerId!,
          pack: found.pack,
          returnUrl,
        }),
      );
      return withTenant(
        req,
        async () => result,
        () => e.planId,
      );
    },
  );

  app.post(
    '/portal',
    { ...admin, schema: { tags, response: { 200: Url, 404: ErrorBody } } },
    async (req) => {
      const sub = await withOrg(db, req.tenant.orgId, currentSubscription);
      const url = sub && (await viaProvider(req.log, () => providerOf(sub).portal(sub, returnUrl)));
      if (!url) throw httpError(404, 'no billing portal for this subscription');
      return { url };
    },
  );

  app.post(
    '/cancel',
    { ...admin, schema: { tags, response: { 204: z.null(), 409: ErrorBody } } },
    async (req, reply) => {
      const sub = await withOrg(db, req.tenant.orgId, currentSubscription);
      if (!sub || (sub.status !== 'active' && sub.status !== 'past_due')) {
        throw httpError(409, 'no active subscription');
      }
      await viaProvider(req.log, () => providerOf(sub).cancel(sub));
      await withTenant(req, (tx) =>
        tx
          .update(subscriptions)
          .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
          .where(eq(subscriptions.orgId, sub.orgId)),
      );
      return reply.code(204).send(null);
    },
  );

  // Within plan rules: only plans with `llmLimitRaise`, up to the plan's llmSpendMax.
  app.patch(
    '/llm-limit',
    {
      preHandler: [requireRole('admin'), requireEntitlement('llmLimitRaise')],
      schema: { tags, body: LlmLimit, response: { 204: z.null(), 400: ErrorBody, 402: ErrorBody } },
    },
    async (req, reply) => {
      await withTenant(req, async (tx) => {
        const e = await entitlements(req.tenant.orgId, tx);
        const max = e.plan.llmSpendMax[req.body.currency];
        if (max === undefined || req.body.amount > max || !e.subscription) {
          throw httpError(400, `the plan allows at most ${max ?? 0} ${req.body.currency}`);
        }
        await tx
          .update(subscriptions)
          .set({
            llmSpendLimits: {
              ...e.subscription.llmSpendLimits,
              [req.body.currency]: req.body.amount,
            },
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.orgId, e.subscription.orgId));
      });
      return reply.code(204).send(null);
    },
  );
};

/**
 * Provider webhooks (no session; authenticity is checked by the adapter). Each normalized event
 * becomes a Temporal workflow keyed by the provider event id, so retries and redeliveries are
 * safe. 5xx when Temporal is unreachable: the provider retries.
 */
export const billingWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  // Signatures are computed over the exact bytes: keep the body as a string.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post(
    '/:provider',
    {
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      schema: { hide: true, params: z.object({ provider: z.string().max(32) }) },
    },
    async (req, reply) => {
      const contourId = contourOfProvider(req.params.provider);
      if (!contourId) return reply.code(404).send({ error: 'unknown provider' });
      let events: Awaited<ReturnType<ReturnType<typeof providerFor>['webhook']>>;
      try {
        events = await providerFor(contourId).webhook({
          body: typeof req.body === 'string' ? req.body : '',
          headers: req.headers,
          ip: req.ip,
        });
      } catch (err) {
        if (err instanceof WebhookRejected) {
          req.log.warn({ provider: req.params.provider, reason: err.message }, 'webhook rejected');
          return reply.code(400).send({ error: 'invalid webhook' });
        }
        if (err instanceof ProviderNotConfigured) {
          return reply.code(503).send({ error: 'billing is not configured' });
        }
        throw err;
      }
      for (const event of events) await startBillingEvent(event);
      req.log.info(
        { provider: req.params.provider, events: events.map((e) => e.type) },
        'billing webhook',
      );
      return { received: events.length };
    },
  );
};
