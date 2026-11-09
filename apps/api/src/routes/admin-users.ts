import {
  account,
  auditLog,
  member,
  organization,
  passkey,
  session,
  user,
  withOperatorRead,
} from '@app/db';
import { fromNodeHeaders } from 'better-auth/node';
import { and, count, desc, eq, getTableColumns, gte, ilike, like, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { db } from '../db.ts';
import { isListedOperator } from '../operator-guard.ts';
import { httpError } from '../tenant.ts';
import {
  auditUser,
  authCall,
  ErrorBody,
  Id,
  iso,
  likeArg,
  Page,
  requireOperator,
  WithReason,
} from './admin-common.ts';

/** Users: list, detail, revoke sessions, view as user (docs/admin.md). */
export const adminUserRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const op = { preHandler: requireOperator, schema: { tags, hide: true } };

  const UserRow = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    twoFactor: z.boolean(),
    operator: z.boolean(),
    orgs: z.number(),
    lastSignInAt: z.string().nullable(),
    createdAt: z.string(),
  });
  const lastSignIn = sql<
    string | null
  >`(select max(${session.createdAt}) from ${session} where ${session.userId} = ${user.id} and ${session.impersonatedBy} is null)`;
  const orgCount = sql<number>`(select count(*)::int from ${member} where ${member.userId} = ${user.id})`;

  // Auth tables are not tenant-scoped (ADR 0002): plain reads, no RLS exception needed.
  app.get(
    '/users',
    {
      ...op,
      schema: {
        ...op.schema,
        querystring: z.object({ q: z.string().trim().max(200).optional(), ...Page }),
        response: { 200: z.object({ items: z.array(UserRow), total: z.number() }) },
      },
    },
    async (req) => {
      const { q, limit, offset } = req.query;
      const cond = q
        ? or(ilike(user.email, likeArg(q)), ilike(user.name, likeArg(q)), eq(user.id, q))
        : undefined;
      const rows = await db
        .select({ u: getTableColumns(user), orgs: orgCount, lastSignInAt: lastSignIn })
        .from(user)
        .where(cond)
        .orderBy(desc(user.createdAt))
        .limit(limit)
        .offset(offset);
      const [total] = await db.select({ n: count() }).from(user).where(cond);
      return {
        items: rows.map(({ u, orgs, lastSignInAt }) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          emailVerified: u.emailVerified,
          twoFactor: u.twoFactorEnabled === true,
          operator: u.role === 'operator',
          orgs: Number(orgs),
          lastSignInAt: iso(lastSignInAt),
          createdAt: iso(u.createdAt)!,
        })),
        total: total?.n ?? 0,
      };
    },
  );

  app.get(
    '/users/:id',
    {
      ...op,
      schema: {
        ...op.schema,
        params: Id,
        response: {
          200: UserRow.extend({
            passkeys: z.array(
              z.object({
                id: z.string(),
                name: z.string().nullable(),
                createdAt: z.string().nullable(),
              }),
            ),
            signInMethods: z.array(z.string()),
            memberships: z.array(
              z.object({
                orgId: z.string(),
                name: z.string(),
                role: z.string(),
                suspended: z.boolean(),
              }),
            ),
            sessions: z.array(
              z.object({
                id: z.string(),
                createdAt: z.string(),
                expiresAt: z.string(),
                ipAddress: z.string().nullable(),
                userAgent: z.string().nullable(),
                impersonatedBy: z.string().nullable(),
              }),
            ),
            operatorActions: z.array(
              z.object({
                action: z.string(),
                actorEmail: z.string().nullable(),
                reason: z.string().nullable(),
                expiresAt: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
          404: ErrorBody,
        },
      },
    },
    async (req) => {
      const id = req.params.id;
      const [row] = await db
        .select({ u: getTableColumns(user), orgs: orgCount, lastSignInAt: lastSignIn })
        .from(user)
        .where(eq(user.id, id));
      if (!row) throw httpError(404, 'not found');
      const u = row.u;
      const keys = await db.select().from(passkey).where(eq(passkey.userId, id));
      const methods = await db
        .select({ p: account.providerId })
        .from(account)
        .where(eq(account.userId, id));
      const memberships = await db
        .select({
          orgId: organization.id,
          name: organization.name,
          role: member.role,
          suspendedAt: organization.suspendedAt,
        })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(eq(member.userId, id));
      // Never the token: the id is enough to recognise a session.
      const sessions = await db
        .select({
          id: session.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          impersonatedBy: session.impersonatedBy,
        })
        .from(session)
        .where(and(eq(session.userId, id), gte(session.expiresAt, new Date())))
        .orderBy(desc(session.createdAt));
      // ponytail: scans audit_log by target across orgs; add an index on (target) if it gets slow.
      const actor = sql<
        string | null
      >`(select ${user.email} from ${user} where ${user.id} = ${auditLog.actorId})`;
      const actions = await withOperatorRead(db, (tx) =>
        tx
          .selectDistinctOn([auditLog.createdAt, auditLog.action], {
            action: auditLog.action,
            actorEmail: actor,
            reason: auditLog.reason,
            expiresAt: auditLog.expiresAt,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(and(eq(auditLog.target, id), like(auditLog.action, 'operator.%')))
          .orderBy(desc(auditLog.createdAt), auditLog.action)
          .limit(50),
      );
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: u.emailVerified,
        twoFactor: u.twoFactorEnabled === true,
        operator: u.role === 'operator',
        orgs: Number(row.orgs),
        lastSignInAt: iso(row.lastSignInAt),
        createdAt: iso(u.createdAt)!,
        passkeys: keys.map((k) => ({ id: k.id, name: k.name, createdAt: iso(k.createdAt) })),
        signInMethods: [...new Set(methods.map((m) => m.p))],
        memberships: memberships.map((m) => ({
          orgId: m.orgId,
          name: m.name,
          role: m.role,
          suspended: m.suspendedAt !== null,
        })),
        sessions: sessions.map((s) => ({
          ...s,
          createdAt: iso(s.createdAt)!,
          expiresAt: iso(s.expiresAt)!,
        })),
        operatorActions: actions.map((a) => ({
          ...a,
          expiresAt: iso(a.expiresAt),
          createdAt: iso(a.createdAt)!,
        })),
      };
    },
  );

  const target = async (id: string) => {
    const [u] = await db.select().from(user).where(eq(user.id, id));
    if (!u) throw httpError(404, 'not found');
    return u;
  };

  app.post(
    '/users/:id/revoke-sessions',
    {
      ...op,
      schema: {
        ...op.schema,
        params: Id,
        body: WithReason,
        response: { 204: z.null(), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const u = await target(req.params.id);
      // In the audit transaction (no session cache in front of the table: auth.ts).
      await auditUser(req, u.id, 'user.sessions_revoked', req.body.reason, (tx) =>
        tx.delete(session).where(eq(session.userId, u.id)),
      );
      return reply.code(204).send(null);
    },
  );

  // "View as user": a new session of the user marked impersonatedBy, time-boxed
  // (OPERATOR_IMPERSONATION_MINUTES), read-only (tenant.ts, operator-guard.ts). The operator's own
  // session waits in Better Auth's signed admin_session cookie until /impersonation/stop.
  app.post(
    '/users/:id/impersonate',
    {
      ...op,
      schema: {
        ...op.schema,
        params: Id,
        body: WithReason.extend({ orgId: z.string().min(1).max(100).optional() }),
        response: {
          200: z.object({ expiresAt: z.string() }),
          400: ErrorBody,
          403: ErrorBody,
          404: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const u = await target(req.params.id);
      // Also listed accounts not yet promoted: the plugin only knows the role.
      if (u.role === 'operator' || isListedOperator(u)) {
        throw httpError(403, 'operators cannot be viewed as');
      }
      if (req.body.orgId) {
        const [m] = await db
          .select()
          .from(member)
          .where(and(eq(member.userId, u.id), eq(member.organizationId, req.body.orgId)));
        if (!m) throw httpError(400, 'the user is not a member of this organization');
      }
      let created: string | undefined;
      try {
        const { headers, response } = await auditUser(
          req,
          u.id,
          'impersonation.started',
          req.body.reason,
          async (tx) => {
            const res = await authCall(
              auth.api.impersonateUser({
                body: { userId: u.id },
                headers: fromNodeHeaders(req.headers),
                returnHeaders: true,
              }),
            );
            created = res.response.session.id;
            if (req.body.orgId) {
              await tx
                .update(session)
                .set({ activeOrganizationId: req.body.orgId })
                .where(eq(session.id, created));
            }
            return res;
          },
          // The "ended" time unless stopped earlier (then an impersonation.ended row follows).
          (res) => new Date(res.response.session.expiresAt),
        );
        reply.header('set-cookie', headers.getSetCookie());
        return { expiresAt: iso(response.session.expiresAt)! };
      } catch (err) {
        // Better Auth committed the session on its own connection: no audit row, no session.
        if (created) await db.delete(session).where(eq(session.id, created));
        throw err;
      }
    },
  );
};
