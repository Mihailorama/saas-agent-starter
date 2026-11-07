import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auth } from '../auth.ts';
import {
  httpError,
  requireRole,
  roleRank,
  SCOPES,
  type Scope,
  scopes,
  withTenant,
} from '../tenant.ts';

/**
 * Organization API keys (docs/public-api.md), managed by org admins with a session only (a key
 * can never mint or revoke keys). Storage, hashing and verification: @better-auth/api-key.
 * Create and revoke are audit-logged by withTenant (POST/DELETE).
 */
const ApiKey = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /** First characters of the key (prefix included), to recognise it. */
  start: z.string().nullable(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
const ApiKeyInput = z.object({
  name: z.string().trim().min(1).max(32),
  scopes: z.array(z.enum(scopes)).min(1),
  /** null = never expires. */
  expiresInDays: z.number().int().min(1).max(365).nullable(),
});
const Id = z.object({ id: z.string().min(1).max(100) });
const ErrorBody = z.object({ error: z.string() });

type Permissions = Record<string, string[]> | null | undefined;
const toPermissions = (list: Scope[]) => {
  const out: Record<string, string[]> = {};
  for (const s of list) {
    const [resource = '', action = ''] = s.split(':');
    out[resource] = [...(out[resource] ?? []), action];
  }
  return out;
};
const toScopes = (p: Permissions) =>
  Object.entries(p ?? {}).flatMap(([resource, actions]) => actions.map((a) => `${resource}:${a}`));
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const dto = (k: {
  id: string;
  name: string | null;
  start: string | null;
  permissions?: Permissions;
  expiresAt: Date | null;
  lastRequest: Date | null;
  createdAt: Date;
}) => ({
  id: k.id,
  name: k.name,
  start: k.start,
  scopes: toScopes(k.permissions),
  expiresAt: iso(k.expiresAt),
  lastUsedAt: iso(k.lastRequest),
  createdAt: iso(k.createdAt)!,
});

/** Better Auth APIErrors carry a statusCode; pass 4xx through, everything else is a 500. */
const authCall = <T>(p: Promise<T>) =>
  p.catch((err: { statusCode?: number; message?: string }) => {
    const status = err.statusCode ?? 500;
    throw status < 500 ? httpError(status, err.message || 'request failed') : err;
  });
const headers = (req: FastifyRequest) => fromNodeHeaders(req.headers);

export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = { preHandler: requireRole('admin') };
  const tags = ['api-keys'];

  app.get(
    '/scopes',
    {
      ...admin,
      schema: {
        tags,
        response: { 200: z.array(z.object({ scope: z.string(), role: z.string() })) },
      },
    },
    async () => scopes.map((scope) => ({ scope, role: SCOPES[scope] })),
  );

  app.get('/', { ...admin, schema: { tags, response: { 200: z.array(ApiKey) } } }, async (req) => {
    const { apiKeys } = await authCall(
      auth.api.listApiKeys({ query: { organizationId: req.tenant.orgId }, headers: headers(req) }),
    );
    return apiKeys.map(dto).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.post(
    '/',
    {
      ...admin,
      schema: {
        tags,
        body: ApiKeyInput,
        response: { 201: z.object({ key: z.string(), apiKey: ApiKey }), 403: ErrorBody },
      },
    },
    async (req, reply) => {
      const tooHigh = req.body.scopes.filter((s) => roleRank(SCOPES[s]) > req.tenant.rank);
      if (tooHigh.length) throw httpError(403, `your role cannot grant ${tooHigh.join(', ')}`);
      const created = await authCall(
        auth.api.createApiKey({
          body: {
            organizationId: req.tenant.orgId,
            userId: req.tenant.userId,
            name: req.body.name,
            expiresIn: req.body.expiresInDays && req.body.expiresInDays * 86_400,
            permissions: toPermissions([...new Set(req.body.scopes)]),
          },
        }),
      );
      // Audit row (POST /api/api-keys, target = key id); the key itself is never logged.
      await withTenant(
        req,
        async () => created,
        (k) => k.id,
      );
      return reply.code(201).send({ key: created.key, apiKey: dto(created) });
    },
  );

  app.delete('/:id', { ...admin, schema: { tags, params: Id } }, async (req, reply) => {
    const key = await auth.api
      .getApiKey({ query: { id: req.params.id }, headers: headers(req) })
      .catch(() => null);
    // Keys of other organizations (even ones this user administers) look like missing ones.
    if (!key || key.referenceId !== req.tenant.orgId) throw httpError(404, 'not found');
    await authCall(auth.api.deleteApiKey({ body: { keyId: key.id }, headers: headers(req) }));
    await withTenant(req, async () => undefined);
    return reply.code(204).send();
  });
};
