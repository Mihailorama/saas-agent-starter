import { auditLog, member, type Tx, user, withOrg } from '@app/db';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { db } from '../db.ts';
import { env } from '../env.ts';
import { isListedOperator } from '../operator-guard.ts';
import { bearerToken, httpError } from '../tenant.ts';

/** Shared by the operator console routes (admin.ts, admin-orgs.ts, admin-users.ts). */

export type Operator = { id: string; email: string };
declare module 'fastify' {
  interface FastifyRequest {
    operator: Operator;
  }
}

/** preHandler: an operator (OPERATOR_EMAILS + role) with TOTP and a fresh session. */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  if (bearerToken(req)) return reply.code(403).send({ error: 'forbidden' });
  const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!s) return reply.code(401).send({ error: 'unauthorized' });
  // Org owners and admins included: organization roles never make an operator.
  if (!isListedOperator(s.user) || s.session.impersonatedBy) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  if (s.user.role !== 'operator') {
    // Listed since the last sync (e.g. signed up after the API started): apply it now.
    await db.update(user).set({ role: 'operator' }).where(eq(user.id, s.user.id));
  }
  if (!s.user.twoFactorEnabled) {
    return reply.code(403).send({ error: 'operators need two-factor authentication' });
  }
  const age = Date.now() - new Date(s.session.createdAt).getTime();
  if (age > env.OPERATOR_SESSION_MAX_AGE_MINUTES * 60_000) {
    return reply.code(401).send({ error: 'operator session expired: sign in again' });
  }
  req.operator = { id: s.user.id, email: s.user.email };
}

export const Reason = z.string().trim().min(3).max(500);
export const WithReason = z.object({ reason: Reason });
export const Id = z.object({ id: z.string().min(1).max(100) });
export const Page = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
export const ErrorBody = z.object({ error: z.string() });
export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
export const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** One audit row in `orgId` (null: platform row for a user without organization). */
export function audit(
  tx: Tx,
  req: FastifyRequest,
  orgId: string | null,
  action: string,
  target: string,
  reason: string | null,
  createdAt = new Date(),
) {
  return tx.insert(auditLog).values({
    orgId,
    actorId: req.operator.id,
    action: `operator.${action}`,
    target,
    reason,
    ip: req.ip,
    createdAt,
  });
}

/**
 * User-level actions: one row in each of the user's organizations (same timestamp), so their
 * admins see it; a platform row (org_id null, operators only) for a user without organization.
 * After the change, like mfa.ts: a crash in between loses the row, never the other way round.
 */
export async function auditUser(
  req: FastifyRequest,
  userId: string,
  action: string,
  reason: string,
) {
  const at = new Date();
  const orgs = await db
    .select({ orgId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  if (!orgs.length) {
    await db.transaction((tx) => audit(tx, req, null, action, userId, reason, at));
  }
  for (const { orgId } of orgs) {
    await withOrg(db, orgId, (tx) => audit(tx, req, orgId, action, userId, reason, at));
  }
}

/** Better Auth APIErrors carry a statusCode; pass 4xx through. */
export const authCall = <T>(p: Promise<T>) =>
  p.catch((err: { statusCode?: number; message?: string }) => {
    const status = err.statusCode ?? 500;
    throw status < 500 ? httpError(status, err.message || 'request failed') : err;
  });

/** Operators see why a request failed (`{ error }` with the message); 5xx stay generic. */
export const errorHandler = (
  err: { statusCode?: number; message: string },
  _req: FastifyRequest,
  reply: FastifyReply,
) => {
  const status = err.statusCode ?? 500;
  return reply.code(status).send({ error: status < 500 ? err.message : 'internal error' });
};
