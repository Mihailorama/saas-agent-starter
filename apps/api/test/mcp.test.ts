// MCP server (/mcp, docs/mcp.md): the official MCP client, on both protocol eras, against the app
// through app.inject. Feature flag, API key auth, scopes, cross-org isolation, audit.
import { randomUUID } from 'node:crypto';
import { auditLog, user, withOrg } from '@app/db';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { signUp } from './sign-in.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { closeTemporal } from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
// FLAGS_ON is read per request: switch the flag per test.
const flag = (on: boolean) =>
  env.FLAGS_ON.splice(0, env.FLAGS_ON.length, ...(on ? ['mcp-server'] : []));

afterAll(async () => {
  flag(false);
  await app.close();
  await closeTemporal();
  await pool.end();
});

async function newOrg() {
  const post = (url: string, payload: object, cookie?: string) =>
    app.inject({
      method: 'POST',
      url,
      remoteAddress: ip(),
      headers: { origin, ...(cookie && { cookie }) },
      payload,
    });
  const { cookie } = await signUp(app);
  const org = (
    await post('/api/auth/organization/create', { name: 'Org', slug: randomUUID() }, cookie)
  ).json().id;
  const key = async (scopes: string[]) => {
    const res = await post('/api/api-keys', { name: 'agent', scopes, expiresInDays: null }, cookie);
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { key: string; apiKey: { id: string } };
  };
  return { org, cookie, key };
}

/** fetch() for the MCP client: the request goes to the app in-process. */
const injectFetch = async (url: string | URL, init?: RequestInit) => {
  const res = await app.inject({
    method: (init?.method ?? 'GET') as 'POST',
    url: new URL(url).pathname,
    remoteAddress: ip(),
    headers: Object.fromEntries(new Headers(init?.headers)),
    ...(init?.body && { payload: init.body as string }),
  });
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, String(v));
  return new Response(res.rawPayload.length ? new Uint8Array(res.rawPayload) : null, {
    status: res.statusCode,
    headers,
  });
};

async function connect(key: string, era: 'modern' | 'legacy' = 'modern') {
  const client = new Client(
    { name: 'test-agent', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: injectFetch,
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return client;
}

const mcpPost = (headers: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    remoteAddress: ip(),
    headers: { accept: 'application/json, text/event-stream', ...headers },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });

describe('MCP server', () => {
  it('flag off: /mcp is 404, also with a valid key', async () => {
    flag(false);
    const { key } = await (await newOrg()).key(['projects:read']);
    const res = await mcpPost({ authorization: `Bearer ${key}` });
    expect(res.statusCode).toBe(404);
  });

  it('flag off: without a valid key it is 401, as with the flag on (key checked first)', async () => {
    flag(false);
    expect((await mcpPost({})).statusCode).toBe(401);
    expect((await mcpPost({ authorization: 'Bearer nope' })).statusCode).toBe(401);
  });

  describe('flag on', () => {
    beforeAll(() => flag(true));

    it('needs an API key: none, a bad one or a session cookie is 401', async () => {
      const { cookie } = await newOrg();
      for (const headers of [{}, { authorization: 'Bearer sk_nope' }, { cookie }] as Record<
        string,
        string
      >[]) {
        const res = await mcpPost(headers);
        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
      }
    });

    it('lists only the tools the key scopes cover; reads and writes go through the REST path', async () => {
      const a = await newOrg();
      const full = await a.key(['projects:read', 'projects:write']);
      const readOnly = await a.key(['projects:read']);

      for (const era of ['modern', 'legacy'] as const) {
        const client = await connect(full.key, era);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'create_project',
          'get_project',
          'list_projects',
        ]);
        await client.close();
      }
      const ro = await connect(readOnly.key);
      expect((await ro.listTools()).tools.map((t) => t.name).sort()).toEqual([
        'get_project',
        'list_projects',
      ]);
      const refused = await ro
        .callTool({ name: 'create_project', arguments: { name: 'x' } })
        .catch((e) => e);
      expect(refused).toMatchObject({ code: -32602 }); // unknown tool

      const client = await connect(full.key);
      const created = await client.callTool({
        name: 'create_project',
        arguments: { name: 'From agent' },
      });
      expect(created.isError).toBeFalsy();
      const project = created.structuredContent as { id: string; name: string };
      expect(project.name).toBe('From agent');
      const got = await client.callTool({ name: 'get_project', arguments: { id: project.id } });
      expect(got.structuredContent).toMatchObject({ id: project.id });
      const listed = await ro.callTool({ name: 'list_projects', arguments: {} });
      expect(
        (listed.structuredContent as { projects: { id: string }[] }).projects.map((p) => p.id),
      ).toEqual([project.id]);
      // Invalid input is refused by the same Zod schema as the REST route.
      const invalid = await client.callTool({ name: 'create_project', arguments: { name: '' } });
      expect(invalid.isError).toBe(true);

      // Same audit row as the REST call, by the key; reads write none.
      const audit = await withOrg(db, a.org, (tx) => tx.select().from(auditLog));
      expect(
        audit
          .filter((r) => r.actorId?.startsWith('apikey:'))
          .map((r) => [r.action, r.target, r.actorId]),
      ).toEqual([['POST /api/projects', project.id, `apikey:${full.apiKey.id}`]]);
      await client.close();
      await ro.close();
    });

    it("a key from another org sees nothing of this org's projects (404)", async () => {
      const a = await newOrg();
      const b = await newOrg();
      const writer = await connect((await a.key(['projects:read', 'projects:write'])).key);
      const created = await writer.callTool({
        name: 'create_project',
        arguments: { name: 'Secret' },
      });
      const { id } = created.structuredContent as { id: string };

      const other = await connect((await b.key(['projects:read'])).key);
      const got = await other.callTool({ name: 'get_project', arguments: { id } });
      expect(got.isError).toBe(true);
      expect(got.content).toEqual([{ type: 'text', text: 'Not Found' }]); // as REST: 404
      const listed = await other.callTool({ name: 'list_projects', arguments: {} });
      expect(listed.structuredContent).toEqual({ projects: [] });
      await writer.close();
      await other.close();
    });
  });
});
