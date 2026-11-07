import { auditLog, member, type Tx, withOrg } from '@app/db';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth } from './auth.ts';
import { db } from './db.ts';
import { flushEvents } from './events.ts';

export type Role = 'member' | 'admin' | 'owner';
const RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };
export type Tenant = { userId: string; orgId: string; rank: number };

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
  }
  interface FastifyContextConfig {
    /** Set by access(): the API key scope this route accepts (also shown in OpenAPI). */
    scope?: Scope;
  }
}

/**
 * API key scopes (docs/public-api.md), each mapped to the role a session needs for the same
 * routes. A key gets only scopes whose role its creator has; it never manages API keys.
 */
export const SCOPES = {
  'projects:read': 'member',
  'projects:write': 'member',
  'projects:delete': 'admin',
  'ai_calls:read': 'admin',
  'webhooks:read': 'admin',
  'webhooks:write': 'admin',
} as const satisfies Record<string, Role>;
export type Scope = keyof typeof SCOPES;
export const scopes = Object.keys(SCOPES) as Scope[];
export const roleRank = (role: string) => RANK[role] ?? 0;

export const bearerToken = (req: FastifyRequest) =>
  req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];

export const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/**
 * preHandler for every tenant route: needs a session with an active organization
 * in which the user has at least role `min` (owner > admin > member).
 */
export const requireRole = (min: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (bearerToken(req)) {
    return reply.code(403).send({ error: 'API keys are not accepted on this route' });
  }
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return reply.code(401).send({ error: 'unauthorized' });
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return reply.code(403).send({ error: 'no active organization' });
  const [m] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)));
  // Better Auth stores multiple roles comma-separated; the highest one counts.
  const rank = Math.max(0, ...(m?.role.split(',') ?? []).map((r) => RANK[r.trim()] ?? 0));
  if (rank < (RANK[min] ?? Number.POSITIVE_INFINITY)) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  req.tenant = { userId: session.user.id, orgId, rank };
};

/**
 * preHandler for a public API route: `Authorization: Bearer <API key>` with `scope`, or a
 * session whose role is at least SCOPES[scope]. A key acts in the organization that owns it.
 */
export const requireScope = (scope: Scope) => {
  const sessionCheck = requireRole(SCOPES[scope]);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req);
    if (!token) return sessionCheck(req, reply);
    const { valid, key } = await auth.api.verifyApiKey({ body: { key: token } });
    if (!valid || !key) return reply.code(401).send({ error: 'invalid API key' });
    const [resource = '', action = ''] = scope.split(':');
    if (!key.permissions?.[resource]?.includes(action)) {
      return reply.code(403).send({ error: `API key lacks scope ${scope}` });
    }
    req.tenant = { userId: `apikey:${key.id}`, orgId: key.referenceId, rank: RANK[SCOPES[scope]]! };
  };
};

/** Route options for a public API route (see requireScope). */
export const access = (scope: Scope) => ({ preHandler: requireScope(scope), config: { scope } });

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
  const committed = withOrg(db, orgId, async (tx) => {
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
  // Events from publishEvent() in this transaction are delivered only once it committed.
  return committed.then(async (result) => {
    await flushEvents(req);
    return result;
  });
}
