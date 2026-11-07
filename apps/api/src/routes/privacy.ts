import { member, organization, privacyRequests, type Tx, user } from '@app/db';
import { fromNodeHeaders } from 'better-auth/node';
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { db } from '../db.ts';
import { pickLocale, renderEmail } from '../email.ts';
import { env } from '../env.ts';
import { audit, REAUTH_MAX_AGE_SECONDS } from '../mfa.ts';
import { presignDownload } from '../s3.ts';
import { type PrivacyRequest, signalPrivacyCancel, startPrivacyRequest } from '../temporal.ts';
import { bearerToken, httpError, requireRole, withTenant } from '../tenant.ts';

/**
 * Data-subject rights (docs/privacy.md, ADR 0021): a user exports or deletes their own data, an
 * organization owner the organization's. The worker's DataExportWorkflow / DataDeletionWorkflow
 * do the work; a request row is the audit record and the only state kept here.
 */
type Subject = 'user' | 'org';
type Row = typeof privacyRequests.$inferSelect;

const Request = z.object({
  id: z.uuid(),
  kind: z.enum(['export', 'deletion']),
  status: z.enum(['scheduled', 'running', 'completed', 'failed', 'cancelled']),
  executeAfter: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  /** Export: the ZIP is ready to download. */
  downloadable: z.boolean(),
  /** Deletion: what was deleted where, and what could not be (and why). */
  report: z.unknown(),
});
const Id = z.object({ id: z.uuid() });
const ErrorBody = z.object({ error: z.string() });
export const NOT_FRESH = 'sign in again to confirm this request';

const iso = (d: Date | null) => d?.toISOString() ?? null;
const dto = (r: Row) => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  executeAfter: r.executeAfter.toISOString(),
  expiresAt: iso(r.expiresAt),
  createdAt: r.createdAt.toISOString(),
  completedAt: iso(r.completedAt),
  downloadable: Boolean(r.resultKey) && r.status === 'completed',
  report: r.report ?? null,
});

/** Session only (a user's own data needs no organization). API keys never reach these routes. */
async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (bearerToken(req)) return reply.code(403).send({ error: 'API keys are not accepted here' });
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return reply.code(401).send({ error: 'unauthorized' });
  req.tenant = {
    userId: session.user.id,
    orgId: session.session.activeOrganizationId ?? '',
    rank: 0,
    twoFactor: session.user.twoFactorEnabled === true,
  };
}

/** Deletion needs a recent sign-in (password + 2FA, or passkey), like other sensitive changes. */
async function requireFresh(req: FastifyRequest) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  const age = session ? Date.now() - new Date(session.session.createdAt).getTime() : Infinity;
  if (age > REAUTH_MAX_AGE_SECONDS * 1000) throw httpError(403, NOT_FRESH);
}

/** GA4 client id from the `_ga` cookie (`GA1.1.<random>.<timestamp>`), for GA4 User Deletion. */
export const gaClientId = (cookie: string | undefined) =>
  cookie?.match(/(?:^|;\s*)_ga=GA\d\.\d+\.(\d+\.\d+)/)?.[1];

export const privacyRoutes: FastifyPluginAsyncZod = async (app) => {
  // The reason matters to the user here (re-auth, sole owner, rate limit): send it as `error`.
  app.setErrorHandler((err: { statusCode?: number; message: string }, _req, reply) => {
    if ((err.statusCode ?? 500) >= 500) throw err;
    return reply.code(err.statusCode!).send({ error: err.message });
  });
  for (const subject of ['user', 'org'] as const satisfies Subject[]) {
    const tags = ['privacy'];
    const preHandler = subject === 'user' ? requireUser : requireRole('owner');
    const subjectId = (req: FastifyRequest) =>
      subject === 'user' ? req.tenant.userId : req.tenant.orgId;
    const mine = (req: FastifyRequest) =>
      and(eq(privacyRequests.subjectType, subject), eq(privacyRequests.subjectId, subjectId(req)));
    /** Org requests: in the tenant transaction, so withTenant writes the audit_log row. User
     * requests: an audit_log row in each of the user's organizations (as mfa.ts does). */
    const recorded = async (req: FastifyRequest, action: string, fn: (tx: Tx) => Promise<Row>) => {
      if (subject === 'org') return withTenant(req, fn, (r) => r.id);
      const row = await db.transaction(fn);
      await audit(req.tenant.userId, `privacy.${action}`, row.id, req.ip);
      return row;
    };
    /** Starts the workflow after commit; if Temporal refuses, the request is marked failed. */
    const start = async (req: FastifyRequest, row: Row, extra: Partial<PrivacyRequest> = {}) => {
      try {
        await startPrivacyRequest({
          requestId: row.id,
          kind: row.kind,
          subjectType: subject,
          subjectId: row.subjectId,
          executeAfter: row.executeAfter.toISOString(),
          ...extra,
        });
        return row;
      } catch (err) {
        req.log.error({ err, requestId: row.id }, 'failed to start privacy workflow');
        await db
          .update(privacyRequests)
          .set({ status: 'failed', completedAt: new Date() })
          .where(eq(privacyRequests.id, row.id));
        throw httpError(503, 'could not start the request, try again later');
      }
    };
    const prefix = `/${subject}`;

    app.get(
      `${prefix}/requests`,
      { preHandler, schema: { tags, response: { 200: z.array(Request) } } },
      async (req) =>
        (
          await db
            .select()
            .from(privacyRequests)
            .where(mine(req))
            .orderBy(desc(privacyRequests.createdAt))
            .limit(50)
        ).map(dto),
    );

    app.post(
      `${prefix}/export`,
      {
        preHandler,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { tags, response: { 202: Request, 429: ErrorBody } },
      },
      async (req, reply) => {
        const since = new Date(Date.now() - env.PRIVACY_EXPORT_INTERVAL_HOURS * 3_600_000);
        const [recent] = await db
          .select({ id: privacyRequests.id })
          .from(privacyRequests)
          .where(
            and(
              mine(req),
              eq(privacyRequests.kind, 'export'),
              ne(privacyRequests.status, 'failed'),
              gt(privacyRequests.createdAt, since),
            ),
          );
        if (recent) throw httpError(429, 'an export was requested recently, try again later');
        const [me] = await db.select().from(user).where(eq(user.id, req.tenant.userId));
        const [org] =
          subject === 'org'
            ? await db.select().from(organization).where(eq(organization.id, req.tenant.orgId))
            : [];
        const row = await recorded(req, 'export_requested', async (tx) => {
          const [r] = await tx
            .insert(privacyRequests)
            .values({
              kind: 'export',
              subjectType: subject,
              subjectId: subjectId(req),
              requestedBy: req.tenant.userId,
              status: 'running',
            })
            .returning();
          return r!;
        });
        const locale = pickLocale(req.headers['accept-language']);
        const mail = await renderEmail(
          'data-export-ready',
          locale,
          `${env.BETTER_AUTH_URL}/settings/privacy`,
          { name: me?.name, org: org?.name },
        );
        await start(req, row, { email: { kind: 'data-export-ready', to: me!.email, ...mail } });
        return reply.code(202).send(dto(row));
      },
    );

    app.post(
      `${prefix}/deletion`,
      {
        preHandler,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { tags, response: { 202: Request, 403: ErrorBody, 409: ErrorBody } },
      },
      async (req, reply) => {
        await requireFresh(req);
        if (subject === 'user') {
          // An organization must never be left without an owner: hand it over or delete it first.
          const solelyOwned = await db
            .select({ orgId: member.organizationId })
            .from(member)
            .where(
              and(
                eq(member.userId, req.tenant.userId),
                sql`${member.role} ~ '(^|,)\\s*owner\\s*(,|$)'`,
                sql`not exists (select 1 from ${member} o where o.organization_id = ${member.organizationId}
                  and o.user_id <> ${req.tenant.userId} and o.role ~ '(^|,)\\s*owner\\s*(,|$)')`,
              ),
            );
          if (solelyOwned.length) {
            throw httpError(
              409,
              `you are the only owner of ${solelyOwned.length} organization(s): transfer ownership or delete them first`,
            );
          }
        }
        const executeAfter = new Date(Date.now() + env.PRIVACY_DELETION_GRACE_DAYS * 86_400_000);
        const row = await recorded(req, 'deletion_requested', async (tx) => {
          const [r] = await tx
            .insert(privacyRequests)
            .values({
              kind: 'deletion',
              subjectType: subject,
              subjectId: subjectId(req),
              requestedBy: req.tenant.userId,
              status: 'scheduled',
              executeAfter,
            })
            .onConflictDoNothing()
            .returning();
          if (!r) throw httpError(409, 'a deletion is already scheduled');
          return r;
        });
        const ga = subject === 'user' ? gaClientId(req.headers.cookie) : undefined;
        await start(req, row, ga ? { gaClientId: ga } : {});
        return reply.code(202).send(dto(row));
      },
    );

    app.post(
      `${prefix}/requests/:id/cancel`,
      { preHandler, schema: { tags, params: Id, response: { 200: Request, 409: ErrorBody } } },
      async (req) => {
        // The row decides, not the workflow: it starts only if the row is still `scheduled`.
        const row = await recorded(req, 'deletion_cancelled', async (tx) => {
          const [r] = await tx
            .update(privacyRequests)
            .set({ status: 'cancelled', completedAt: new Date() })
            .where(
              and(
                mine(req),
                eq(privacyRequests.id, req.params.id),
                eq(privacyRequests.kind, 'deletion'),
                eq(privacyRequests.status, 'scheduled'),
              ),
            )
            .returning();
          if (!r) throw httpError(409, 'no scheduled deletion with this id');
          return r;
        });
        await signalPrivacyCancel(row.id).catch((err) =>
          req.log.warn({ err, requestId: row.id }, 'cancel signal not delivered'),
        );
        return dto(row);
      },
    );

    app.get(
      `${prefix}/requests/:id/download`,
      {
        preHandler,
        schema: { tags, params: Id, response: { 200: z.object({ url: z.url() }), 404: ErrorBody } },
      },
      async (req) => {
        const [row] = await db
          .select()
          .from(privacyRequests)
          .where(and(mine(req), eq(privacyRequests.id, req.params.id)));
        if (!row?.resultKey || row.status !== 'completed') throw httpError(404, 'not found');
        // A fresh 5-minute link per click: the mail only points here, behind the sign-in.
        const name = `export-${row.createdAt.toISOString().slice(0, 10)}.zip`;
        return { url: await presignDownload(row.resultKey, name) };
      },
    );
  }
};
