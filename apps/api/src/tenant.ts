import { auditLog, member, organization, type Tx, withOrg } from '@app/db';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth } from './auth.ts';
import { db } from './db.ts';

export type Role = 'member' | 'admin' | 'owner';
const RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };
export type Tenant = { userId: string; orgId: string; rank: number; twoFactor: boolean };

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
  }
}

export const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/**
 * preHandler for every tenant route: needs a session with an active organization
 * in which the user has at least role `min` (owner > admin > member), and 2FA if the
 * org requires it (ADR 0017).
 */
export const requireRole = (min: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return reply.code(401).send({ error: 'unauthorized' });
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return reply.code(403).send({ error: 'no active organization' });
  const [m] = await db
    .select({ role: member.role, requireTwoFactor: organization.requireTwoFactor })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)));
  // Better Auth stores multiple roles comma-separated; the highest one counts.
  const rank = Math.max(0, ...(m?.role.split(',') ?? []).map((r) => RANK[r.trim()] ?? 0));
  if (rank < (RANK[min] ?? Number.POSITIVE_INFINITY)) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  const twoFactor = session.user.twoFactorEnabled === true;
  if (m?.requireTwoFactor && !twoFactor) {
    return reply.code(403).send({ error: 'two-factor authentication required' });
  }
  req.tenant = { userId: session.user.id, orgId, rank, twoFactor };
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Runs `fn` inside the tenant's RLS transaction. For mutating requests an
 * audit_log row (actor, org, action, target, ip) is written in the same
 * transaction, so a mutation and its audit entry commit or fail together.
 */
export function withTenant<T>(
  req: FastifyRequest,
  fn: (tx: Tx) => Promise<T>,
  target?: (result: T) => string,
): Promise<T> {
  const { orgId, userId } = req.tenant;
  return withOrg(db, orgId, async (tx) => {
    const result = await fn(tx);
    if (MUTATING.has(req.method)) {
      await tx.insert(auditLog).values({
        orgId,
        actorId: userId,
        action: `${req.method} ${req.routeOptions.url}`,
        target: target?.(result) ?? (req.params as { id?: string }).id ?? null,
        ip: req.ip,
      });
    }
    return result;
  });
}
