import { createHash } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../env.ts';
import { isEnabled } from '../flags.ts';
import { bearerToken, type Scope, verifiedKey } from '../tenant.ts';
import { Id, Project, ProjectInput } from './projects.ts';

/**
 * MCP server for organization API keys (docs/mcp.md, ADR 0027): Streamable HTTP at /mcp,
 * stateless (spec 2026-07-28, plus the SDK's stateless fallback for 2025-era clients), so any
 * replica serves any request. Each tool calls the REST route it mirrors in-process with the
 * caller's key: the same scope check, entitlements, withTenant (RLS), audit row and webhook event.
 */
export const mcpRoutes: FastifyPluginAsync = async (app) => {
  const rest = async (
    req: FastifyRequest,
    tool: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ) => {
    req.log.info({ mcpTool: tool }, 'mcp tool call');
    const res = await app.inject({
      method,
      url,
      remoteAddress: req.ip,
      headers: { authorization: req.headers.authorization ?? '' },
      ...(payload && { payload }),
    });
    const body = res.body ? res.json() : undefined;
    if (res.statusCode >= 400) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: body?.message ?? body?.error ?? `HTTP ${res.statusCode}` },
        ],
      };
    }
    const data = Array.isArray(body) ? { projects: body } : body;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      structuredContent: data,
    };
  };

  // Tools a key's scopes do not cover are not listed; the REST route enforces the scope anyway.
  const server = (req: FastifyRequest, scopes: Set<Scope>) => {
    const mcp = new McpServer({ name: env.APP_NAME, version: '1.0.0' });
    const read = { readOnlyHint: true, openWorldHint: false };
    if (scopes.has('projects:read')) {
      mcp.registerTool(
        'list_projects',
        {
          description: "List the organization's projects, newest first.",
          outputSchema: z.object({ projects: z.array(Project) }),
          annotations: read,
        },
        () => rest(req, 'list_projects', 'GET', '/api/projects'),
      );
      mcp.registerTool(
        'get_project',
        {
          description: 'Get one project by id.',
          inputSchema: Id,
          outputSchema: Project,
          annotations: read,
        },
        ({ id }) => rest(req, 'get_project', 'GET', `/api/projects/${id}`),
      );
    }
    if (scopes.has('projects:write')) {
      mcp.registerTool(
        'create_project',
        {
          description: 'Create a project. Counts against the plan limit.',
          inputSchema: ProjectInput,
          outputSchema: Project,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        (input) => rest(req, 'create_project', 'POST', '/api/projects', input),
      );
    }
    return mcp;
  };

  const handler = createMcpHandler(({ authInfo }) => {
    const { req, scopes } = authInfo!.extra as { req: FastifyRequest; scopes: Set<Scope> };
    return server(req, scopes);
  });
  app.addHook('onClose', () => handler.close());

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    schema: { hide: true },
    // Own counter per key: a tool call also counts once against the REST route's per-key limit.
    config: {
      rateLimit: {
        max: env.API_KEY_RATE_LIMIT_PER_MINUTE,
        timeWindow: '1 minute',
        keyGenerator: (req) =>
          `mcp:${createHash('sha256')
            .update(bearerToken(req) ?? '')
            .digest('base64url')}`,
      },
    },
    handler: async (req, reply) => {
      // API keys only: no session cookies (docs/mcp.md).
      const key = await verifiedKey(req, reply);
      if (!key) return reply;
      if (
        !(await isEnabled('mcp-server', { userId: `apikey:${key.id}`, orgId: key.referenceId }))
      ) {
        return reply.code(404).send({ error: 'not found' });
      }
      const scopes = new Set(
        Object.entries(key.permissions ?? {}).flatMap(([r, actions]) =>
          actions.map((a) => `${r}:${a}` as Scope),
        ),
      );
      const headers = fromNodeHeaders(req.headers);
      headers.delete('content-length');
      const res = await handler.fetch(
        new Request(new URL(req.url, env.BETTER_AUTH_URL), { method: req.method, headers }),
        {
          parsedBody: req.body,
          authInfo: { token: '', clientId: key.id, scopes: [...scopes], extra: { req, scopes } },
        },
      );
      // SSE responses must not be buffered by nginx (apps/web/nginx.conf.template).
      reply.header('x-accel-buffering', 'no');
      return reply.send(res);
    },
  });
};
