import {
  apikey,
  auditLog,
  member,
  organization,
  projects,
  rewardGrants,
  subscriptions,
  type Tx,
  user,
  webhookEndpoints,
  withOperatorRead,
  withOrg,
} from '@app/db';
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { entitlementsOf, type LimitOverrides, llmSpend } from '../billing/entitlements.ts';
import { type Limit, plans } from '../billing/plans.ts';
import { providerFor } from '../billing/registry.ts';
import { db } from '../db.ts';
import { httpError } from '../tenant.ts';
import {
  audit,
  ErrorBody,
  Id,
  iso,
  likeArg,
  Page,
  requireOperator,
  WithReason,
} from './admin-common.ts';
import { costCurrencies } from './billing.ts';

const PAID = ['active', 'past_due'] as ('active' | 'past_due')[];

const LlmUsage = z.object({ currency: z.string(), spent: z.number(), limit: z.number() });
const OrgRow = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  suspended: z.boolean(),
  planId: z.string(),
  planName: z.string(),
  subscriptionStatus: z.string().nullable(),
  members: z.number(),
  llmSpend: z.array(LlmUsage),
  lastActivityAt: z.string().nullable(),
});
const OrgFilter = z.object({
  q: z.string().trim().max(200).optional(),
  plan: z.string().max(64).optional(),
  status: z.enum(['active', 'suspended', 'past_due']).optional(),
  createdFrom: z.iso.date().optional(),
  ...Page,
});

type SubRow = typeof subscriptions.$inferSelect;
async function spendOf(tx: Tx, orgId: string, sub: SubRow | null, overrides: LimitOverrides) {
  const e = entitlementsOf(sub, new Date(), overrides);
  // Inside withOperatorRead every query filters by org explicitly: RLS does not scope it here.
  const spent = await llmSpend(tx, orgId, e.period);
  return {
    e,
    llmSpend: costCurrencies.flatMap((currency) => {
      const limit = e.llmSpendLimit(currency);
      return limit === undefined ? [] : [{ currency, spent: spent[currency] ?? 0, limit }];
    }),
  };
}

/** Query string without a possible token in it: support needs the endpoint, not its secrets. */
const safeUrl = (raw: string) => {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
};

/** Organizations: list, detail, suspend/unsuspend, limits (docs/admin.md). */
/** A pending_manual grant is resolved by an `operator.reward.applied` audit row. */
const unresolved = sql`not exists (select 1 from ${auditLog} where ${auditLog.action} =
  'operator.reward.applied' and ${auditLog.target} = ${rewardGrants.id}::text)`;

export const adminOrgRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const op = { preHandler: requireOperator, schema: { tags, hide: true } };

  app.get(
    '/orgs',
    {
      ...op,
      schema: {
        ...op.schema,
        querystring: OrgFilter,
        response: { 200: z.object({ items: z.array(OrgRow), total: z.number() }) },
      },
    },
    async (req) => {
      const f = req.query;
      const where: (SQL | undefined)[] = [];
      if (f.q) {
        where.push(
          or(
            ilike(organization.name, likeArg(f.q)),
            ilike(organization.slug, likeArg(f.q)),
            eq(organization.id, f.q),
          ),
        );
      }
      if (f.plan) {
        const onPlan = and(eq(subscriptions.planId, f.plan), inArray(subscriptions.status, PAID));
        where.push(
          f.plan === plans.defaultPlan
            ? or(isNull(subscriptions.planId), notInArray(subscriptions.status, PAID), onPlan)
            : onPlan,
        );
      }
      if (f.status === 'suspended') where.push(isNotNull(organization.suspendedAt));
      if (f.status === 'active') where.push(isNull(organization.suspendedAt));
      if (f.status === 'past_due') where.push(eq(subscriptions.status, 'past_due'));
      if (f.createdFrom) where.push(gte(organization.createdAt, new Date(f.createdFrom)));
      const cond = and(...where);
      req.log.info({ operatorId: req.operator.id }, 'operator listed organizations');
      return withOperatorRead(db, async (tx) => {
        const rows = await tx
          .select({
            org: getTableColumns(organization),
            sub: getTableColumns(subscriptions),
            members: sql<number>`(select count(*)::int from ${member} where ${member.organizationId} = ${organization.id})`,
            lastActivityAt: sql<
              string | null
            >`(select max(${auditLog.createdAt}) from ${auditLog} where ${auditLog.orgId} = ${organization.id})`,
          })
          .from(organization)
          .leftJoin(subscriptions, eq(subscriptions.orgId, organization.id))
          .where(cond)
          .orderBy(desc(organization.createdAt))
          .limit(f.limit)
          .offset(f.offset);
        const [total] = await tx
          .select({ n: count() })
          .from(organization)
          .leftJoin(subscriptions, eq(subscriptions.orgId, organization.id))
          .where(cond);
        // ponytail: one spend query per row (page <= 100, index range scan each); a rollup if slow.
        const items = [];
        for (const r of rows) {
          const { e, llmSpend } = await spendOf(tx, r.org.id, r.sub, r.org.limitOverrides);
          items.push({
            id: r.org.id,
            name: r.org.name,
            slug: r.org.slug,
            createdAt: iso(r.org.createdAt)!,
            suspended: r.org.suspendedAt !== null,
            planId: e.planId,
            planName: e.plan.name,
            subscriptionStatus: r.sub?.status ?? null,
            members: Number(r.members),
            llmSpend,
            lastActivityAt: iso(r.lastActivityAt),
          });
        }
        return { items, total: total?.n ?? 0 };
      });
    },
  );

  const Usage = z.object({
    used: z.number(),
    limit: z.number(),
    planLimit: z.number(),
    max: z.number(),
  });
  const OrgDetail = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    createdAt: z.string(),
    suspendedAt: z.string().nullable(),
    suspendReason: z.string().nullable(),
    requireTwoFactor: z.boolean(),
    members: z.array(
      z.object({
        userId: z.string(),
        name: z.string(),
        email: z.string(),
        role: z.string(),
        twoFactor: z.boolean(),
        joinedAt: z.string(),
      }),
    ),
    subscription: z
      .object({
        status: z.string(),
        provider: z.string(),
        currency: z.string(),
        currentPeriodEnd: z.string().nullable(),
        cancelAtPeriodEnd: z.boolean(),
        dashboardUrl: z.string().nullable(),
      })
      .nullable(),
    planId: z.string(),
    planName: z.string(),
    period: z.object({ start: z.string(), end: z.string() }),
    usage: z.object({ seats: Usage, projects: Usage }),
    llmSpend: z.array(LlmUsage.extend({ max: z.number(), raisable: z.boolean() })),
    apiKeys: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        start: z.string().nullable(),
        enabled: z.boolean(),
        expiresAt: z.string().nullable(),
        lastUsedAt: z.string().nullable(),
      }),
    ),
    webhooks: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        enabled: z.boolean(),
        disabledReason: z.string().nullable(),
        consecutiveFailures: z.number(),
        eventTypes: z.array(z.string()),
      }),
    ),
    /** Rewards waiting for an operator (docs/growth.md); `key` finds the provider object. */
    pendingRewards: z.array(
      z.object({
        id: z.string(),
        ruleId: z.string(),
        reward: z.record(z.string(), z.unknown()),
        key: z.string(),
        providerRef: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    audit: z.array(
      z.object({
        id: z.string(),
        action: z.string(),
        actorId: z.string().nullable(),
        actorEmail: z.string().nullable(),
        target: z.string().nullable(),
        reason: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  });

  app.get(
    '/orgs/:id',
    { ...op, schema: { ...op.schema, params: Id, response: { 200: OrgDetail, 404: ErrorBody } } },
    async (req) => {
      const id = req.params.id;
      const detail = await withOperatorRead(db, async (tx) => {
        const [org] = await tx.select().from(organization).where(eq(organization.id, id));
        if (!org) return null;
        const [sub = null] = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.orgId, id));
        const members = await tx
          .select({
            userId: member.userId,
            name: user.name,
            email: user.email,
            role: member.role,
            twoFactor: user.twoFactorEnabled,
            joinedAt: member.createdAt,
          })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(eq(member.organizationId, id))
          .orderBy(member.createdAt);
        const [projectCount] = await tx
          .select({ n: count() })
          .from(projects)
          .where(eq(projects.orgId, id));
        const { e, llmSpend } = await spendOf(tx, id, sub, org.limitOverrides);
        const keys = await tx
          .select()
          .from(apikey)
          .where(eq(apikey.referenceId, id))
          .orderBy(desc(apikey.createdAt));
        const hooks = await tx
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.orgId, id));
        const events = await tx
          .select({ row: getTableColumns(auditLog), actorEmail: user.email })
          .from(auditLog)
          .leftJoin(user, eq(user.id, auditLog.actorId))
          .where(eq(auditLog.orgId, id))
          .orderBy(desc(auditLog.createdAt))
          .limit(50);
        const pending = await tx
          .select()
          .from(rewardGrants)
          .where(
            and(eq(rewardGrants.orgId, id), eq(rewardGrants.status, 'pending_manual'), unresolved),
          );
        let dashboardUrl: string | null = null;
        try {
          dashboardUrl = sub ? providerFor(sub.contour).dashboardUrl(sub) : null;
        } catch {} // provider not configured in this deployment: no link
        const usage = (name: Limit, used: number) => ({
          used,
          limit: e.limits[name],
          planLimit: e.plan.limits[name],
          max: e.plan.limitsMax?.[name] ?? e.plan.limits[name],
        });
        const raisable = e.plan.features.llmLimitRaise === true && sub !== null;
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          createdAt: iso(org.createdAt)!,
          suspendedAt: iso(org.suspendedAt),
          suspendReason: org.suspendReason,
          requireTwoFactor: org.requireTwoFactor,
          members: members.map((m) => ({
            ...m,
            twoFactor: m.twoFactor === true,
            joinedAt: iso(m.joinedAt)!,
          })),
          subscription: sub && {
            status: sub.status,
            provider: sub.provider,
            currency: sub.currency,
            currentPeriodEnd: iso(sub.currentPeriodEnd),
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            dashboardUrl,
          },
          planId: e.planId,
          planName: e.plan.name,
          period: { start: e.period.start.toISOString(), end: e.period.end.toISOString() },
          usage: {
            seats: usage('seats', members.length),
            projects: usage('projects', projectCount?.n ?? 0),
          },
          llmSpend: llmSpend.map((l) => ({
            ...l,
            max: raisable ? (e.plan.llmSpendMax[l.currency] ?? l.limit) : l.limit,
            raisable,
          })),
          apiKeys: keys.map((k) => ({
            id: k.id,
            name: k.name,
            start: k.start,
            enabled: k.enabled && (!k.expiresAt || k.expiresAt > new Date()),
            expiresAt: iso(k.expiresAt),
            lastUsedAt: iso(k.lastRequest),
          })),
          webhooks: hooks.map((h) => ({
            id: h.id,
            url: safeUrl(h.url),
            enabled: h.enabled,
            disabledReason: h.disabledReason,
            consecutiveFailures: h.consecutiveFailures,
            eventTypes: h.eventTypes,
          })),
          pendingRewards: pending.map((g) => ({
            id: g.id,
            ruleId: g.ruleId,
            reward: g.reward,
            key: g.idempotencyKey,
            providerRef: g.providerRef,
            createdAt: iso(g.createdAt)!,
          })),
          audit: events.map(({ row, actorEmail }) => ({
            id: row.id,
            action: row.action,
            actorId: row.actorId,
            actorEmail,
            target: row.target,
            reason: row.reason,
            createdAt: iso(row.createdAt)!,
          })),
        };
      });
      if (!detail) throw httpError(404, 'not found');
      // Looking at an organization's data is recorded in its own audit log.
      await withOrg(db, id, (tx) => audit(tx, req, id, 'org.viewed', id, null));
      return detail;
    },
  );

  // A pending reward applied by hand (credit note, invoice line): reward_grants keeps the row,
  // this audit row with the reference resolves it.
  app.post(
    '/orgs/:id/rewards/:grantId/applied',
    {
      ...op,
      schema: {
        ...op.schema,
        params: z.object({ id: z.string().min(1).max(100), grantId: z.uuid() }),
        body: WithReason,
        response: { 204: z.null(), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const { id, grantId } = req.params;
      await withOrg(db, id, async (tx) => {
        const [g] = await tx
          .select({ id: rewardGrants.id })
          .from(rewardGrants)
          .where(
            and(
              eq(rewardGrants.id, grantId),
              eq(rewardGrants.status, 'pending_manual'),
              unresolved,
            ),
          );
        if (!g) throw httpError(404, 'not found');
        await audit(tx, req, id, 'reward.applied', g.id, req.body.reason);
      });
      return reply.code(204).send(null);
    },
  );

  // Suspend: members get 403 "organization suspended" on every tenant route and cannot enter it;
  // its API keys get the same answer. Nothing is deleted; unsuspend restores everything.
  for (const [path, suspend] of [
    ['suspend', true],
    ['unsuspend', false],
  ] as const) {
    app.post(
      `/orgs/:id/${path}`,
      {
        ...op,
        schema: {
          ...op.schema,
          params: Id,
          body: WithReason,
          response: { 204: z.null(), 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (req, reply) => {
        const id = req.params.id;
        await withOrg(db, id, async (tx) => {
          const [org] = await tx
            .select()
            .from(organization)
            .where(eq(organization.id, id))
            .for('update');
          if (!org) throw httpError(404, 'not found');
          if ((org.suspendedAt !== null) === suspend) {
            throw httpError(409, suspend ? 'already suspended' : 'not suspended');
          }
          await tx
            .update(organization)
            .set(
              suspend
                ? { suspendedAt: new Date(), suspendReason: req.body.reason }
                : { suspendedAt: null, suspendReason: null },
            )
            .where(eq(organization.id, id));
          await audit(
            tx,
            req,
            id,
            suspend ? 'org.suspended' : 'org.unsuspended',
            id,
            req.body.reason,
          );
        });
        return reply.code(204).send(null);
      },
    );
  }

  // Limits within config/plans.json: seats/projects up to the plan's `limitsMax` (null = back to
  // the plan), the LLM spend limit up to `llmSpendMax`, only where the plan allows raising it
  // (the same rule as the org admin's own setting, read by the worker's gateway).
  const Limits = WithReason.extend({
    seats: z.number().int().min(1).max(1e6).nullable().optional(),
    projects: z.number().int().min(0).max(1e6).nullable().optional(),
    llmSpend: z
      .object({ currency: z.string().length(3), amount: z.number().nonnegative().max(1e9) })
      .optional(),
  }).refine(
    (b) => b.seats !== undefined || b.projects !== undefined || b.llmSpend !== undefined,
    'nothing to change',
  );

  app.patch(
    '/orgs/:id/limits',
    {
      ...op,
      schema: {
        ...op.schema,
        params: Id,
        body: Limits,
        response: { 204: z.null(), 400: ErrorBody, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const b = req.body;
      await withOrg(db, id, async (tx) => {
        const [org] = await tx
          .select()
          .from(organization)
          .where(eq(organization.id, id))
          .for('update');
        if (!org) throw httpError(404, 'not found');
        const [sub = null] = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.orgId, id));
        const e = entitlementsOf(sub, new Date(), org.limitOverrides);
        const overrides = { ...org.limitOverrides };
        const changes: string[] = [];
        for (const name of ['seats', 'projects'] as const) {
          const value = b[name];
          if (value === undefined) continue;
          const max = e.plan.limitsMax?.[name] ?? e.plan.limits[name];
          if (value !== null && value > max) {
            throw httpError(400, `the ${e.plan.name} plan allows at most ${max} ${name}`);
          }
          if (value === null) delete overrides[name];
          else overrides[name] = value;
          changes.push(`${name}=${value ?? 'plan'}`);
        }
        if (b.llmSpend) {
          const { currency, amount } = b.llmSpend;
          const max = e.plan.llmSpendMax[currency];
          if (!e.plan.features.llmLimitRaise || !sub || max === undefined || amount > max) {
            throw httpError(
              400,
              !e.plan.features.llmLimitRaise || !sub
                ? `the ${e.plan.name} plan does not allow changing the LLM limit`
                : `the plan allows at most ${max ?? 0} ${currency}`,
            );
          }
          await tx
            .update(subscriptions)
            .set({
              llmSpendLimits: { ...sub.llmSpendLimits, [currency]: amount },
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.orgId, id));
          changes.push(`llm.${currency}=${amount}`);
        }
        await tx
          .update(organization)
          .set({ limitOverrides: Object.keys(overrides).length ? overrides : null })
          .where(eq(organization.id, id));
        await audit(tx, req, id, 'limits.changed', changes.join(' '), b.reason);
      });
      return reply.code(204).send(null);
    },
  );
};
