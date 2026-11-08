import { randomUUID } from 'node:crypto';
import { mcpServers } from '@app/db';
import { desc, eq } from 'drizzle-orm';
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isEnabled } from '../flags.ts';
import { access, httpError, withTenant } from '../tenant.ts';
import { encryptSecret } from '../webhook-secret.ts';

/**
 * Remote MCP servers an organization connects (docs/mcp.md "Calling external tools"): AI features
 * that opt in may call the listed tools of its enabled servers. Org admins, or API keys with
 * mcp_servers:read / mcp_servers:write; feature flag `mcp-tools` (off: 404). The auth header value
 * is encrypted at once (bound to org and row id) and never returned. The API never connects to the
 * URL: the worker checks it against private ranges (MCP_ALLOWED_CIDRS) each time it opens a
 * session and pins the connection to the checked address.
 */
const url = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((u) => {
    const parsed = new URL(u);
    return !parsed.username && !parsed.password;
  }, 'credentials in the URL are not allowed');
/** Headers the MCP transport sets itself. */
const RESERVED = new Set([
  'host',
  'content-type',
  'content-length',
  'accept',
  'connection',
  'mcp-session-id',
  'mcp-protocol-version',
]);
const headerName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,100}$/, 'invalid header name')
  .refine((h) => !RESERVED.has(h.toLowerCase()), 'this header is set by the MCP transport');
const Fields = z.object({
  name: z.string().trim().min(1).max(100),
  url,
  allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, 'invalid tool name')).max(100),
  authHeader: headerName.nullable().optional(),
  authSecret: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().optional(),
});
const Server = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  allowedTools: z.array(z.string()),
  authHeader: z.string().nullable(),
  authSecretHint: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const Id = z.object({ id: z.uuid() });
const ErrorBody = z.object({ error: z.string() });

type Row = typeof mcpServers.$inferSelect;
const dto = ({ orgId: _, authSecret: __, createdAt, updatedAt, ...s }: Row) => ({
  ...s,
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});
const secretFields = (secret: string, orgId: string, id: string) => ({
  authSecret: encryptSecret(secret, `${orgId}/${id}`),
  authSecretHint: secret.slice(-4),
});
/** A secret needs a header to travel in. */
const checkAuth = (header: string | null | undefined, hasSecret: boolean) => {
  if (hasSecret && !header) throw httpError(400, 'authHeader is required with authSecret');
};

export const mcpServerRoutes: FastifyPluginAsyncZod = async (app) => {
  const flag: preHandlerAsyncHookHandler = async (req) => {
    const { userId, orgId } = req.tenant;
    if (!(await isEnabled('mcp-tools', { userId, orgId }))) throw httpError(404, 'not found');
  };
  const read = access('mcp_servers:read');
  const write = access('mcp_servers:write');
  const guard = (a: typeof read) => ({ ...a, preHandler: [a.preHandler, flag] });
  const tags = ['mcp-servers'];

  app.get(
    '/',
    { ...guard(read), schema: { tags, response: { 200: z.array(Server) } } },
    async (req) =>
      withTenant(req, async (tx) =>
        (await tx.select().from(mcpServers).orderBy(desc(mcpServers.createdAt))).map(dto),
      ),
  );

  app.post(
    '/',
    { ...guard(write), schema: { tags, body: Fields, response: { 201: Server, 400: ErrorBody } } },
    async (req, reply) => {
      const { authSecret, authHeader, ...rest } = req.body;
      checkAuth(authHeader, Boolean(authSecret));
      const id = randomUUID();
      const { orgId } = req.tenant;
      const row = await withTenant(
        req,
        async (tx) => {
          const [created] = await tx
            .insert(mcpServers)
            .values({
              id,
              orgId,
              authHeader: authHeader ?? null,
              ...(authSecret && secretFields(authSecret, orgId, id)),
              ...rest,
            })
            .returning();
          return created!;
        },
        (s) => s.id,
      );
      return reply.code(201).send(dto(row));
    },
  );

  app.patch(
    '/:id',
    {
      ...guard(write),
      schema: {
        tags,
        params: Id,
        body: Fields.partial(),
        response: { 200: Server, 400: ErrorBody, 404: ErrorBody },
      },
    },
    async (req) =>
      withTenant(req, async (tx) => {
        const [current] = await tx
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.id, req.params.id));
        if (!current) throw httpError(404, 'not found');
        const { authSecret, authHeader, ...rest } = req.body;
        // Removing the header removes the secret with it.
        const header = authHeader === undefined ? current.authHeader : authHeader;
        const clear = header === null ? { authSecret: null, authSecretHint: null } : {};
        checkAuth(header, Boolean(authSecret));
        const [updated] = await tx
          .update(mcpServers)
          .set({
            ...rest,
            authHeader: header,
            ...clear,
            ...(authSecret && secretFields(authSecret, req.tenant.orgId, current.id)),
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, current.id))
          .returning();
        return dto(updated!);
      }),
  );

  app.delete('/:id', { ...guard(write), schema: { tags, params: Id } }, async (req, reply) => {
    await withTenant(req, async (tx) => {
      const [row] = await tx
        .delete(mcpServers)
        .where(eq(mcpServers.id, req.params.id))
        .returning({ id: mcpServers.id });
      if (!row) throw httpError(404, 'not found');
    });
    return reply.code(204).send();
  });
};
