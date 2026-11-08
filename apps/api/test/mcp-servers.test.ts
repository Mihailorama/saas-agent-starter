// MCP servers an organization connects (docs/mcp.md "Calling external tools"): flag, admin and
// API key access, validation, secret at rest, tenancy. Tool calls are tested in the worker.
import { randomUUID } from 'node:crypto';
import { auditLog, mcpServers, user, withOrg } from '@app/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../src/app.ts');
const { auth } = await import('../src/auth.ts');
const { db, pool } = await import('../src/db.ts');
const { allowedOrigins, env } = await import('../src/env.ts');
const { closeTemporal } = await import('../src/temporal.ts');

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
// The flag override list is read per request.
const withFlag = (on: boolean) =>
  env.FLAGS_ON.splice(0, env.FLAGS_ON.length, ...(on ? ['mcp-tools'] : []));

beforeAll(() => withFlag(true));
afterAll(async () => {
  withFlag(false);
  await app.close();
  await closeTemporal();
  await pool.end();
});

type User = { id: string; cookie: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function signUp(): Promise<User> {
  const credentials = { email: `${randomUUID()}@example.com`, password: 'correct-horse-battery' };
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    remoteAddress: ip(),
    headers: { origin },
    payload: { ...credentials, name: 'T' },
  });
  expect(res.statusCode).toBe(200);
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, credentials.email));
  const signedIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress: ip(),
    headers: { origin },
    payload: credentials,
  });
  return {
    id: res.json().user.id,
    cookie: signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
  };
}

const call = (u: User | null, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, ...(u && { cookie: u.cookie }) },
    ...(payload && { payload }),
  });

async function newOrg() {
  const owner = await signUp();
  const res = await call(owner, 'POST', '/api/auth/organization/create', {
    name: 'Org',
    slug: randomUUID(),
  });
  return { owner, org: res.json().id as string };
}

const server = {
  name: 'Docs search',
  url: 'https://mcp.example.com/mcp',
  purposes: ['project.summary'],
  allowedTools: ['search', 'fetch_page'],
  authHeader: 'Authorization',
  authSecret: 'Bearer local-dev-mcp-token-1234',
};

describe('MCP servers', () => {
  it('stores the secret encrypted, never returns it, and audit-logs changes', async () => {
    const { owner, org } = await newOrg();
    const created = await call(owner, 'POST', '/api/mcp-servers', server);
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({
      authSecretHint: '1234',
      enabled: true,
      allowedTools: ['search', 'fetch_page'],
    });
    expect(JSON.stringify(body)).not.toContain('local-dev-mcp-token');
    const [row] = await withOrg(db, org, (tx) => tx.select().from(mcpServers));
    expect(row!.authSecret).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(row!.authSecret).not.toContain('local-dev-mcp-token');
    expect(JSON.stringify((await call(owner, 'GET', '/api/mcp-servers')).json())).not.toContain(
      'local-dev-mcp-token',
    );

    const patched = await call(owner, 'PATCH', `/api/mcp-servers/${body.id}`, {
      allowedTools: ['search'],
      enabled: false,
    });
    expect(patched.json()).toMatchObject({
      allowedTools: ['search'],
      enabled: false,
      authSecretHint: '1234',
    });
    // Dropping the header drops the secret with it.
    const cleared = await call(owner, 'PATCH', `/api/mcp-servers/${body.id}`, { authHeader: null });
    expect(cleared.json()).toMatchObject({ authHeader: null, authSecretHint: null });
    const [after] = await withOrg(db, org, (tx) => tx.select().from(mcpServers));
    expect(after!.authSecret).toBeNull();

    expect((await call(owner, 'DELETE', `/api/mcp-servers/${body.id}`)).statusCode).toBe(204);
    const audit = await withOrg(db, org, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.target, body.id)),
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      'DELETE /api/mcp-servers/:id',
      'PATCH /api/mcp-servers/:id',
      'PATCH /api/mcp-servers/:id',
      'POST /api/mcp-servers',
    ]);
  });

  it('a stored secret is never sent to a new URL or header without entering it again', async () => {
    const { owner } = await newOrg();
    const { id } = (await call(owner, 'POST', '/api/mcp-servers', server)).json();
    const patch = (body: object) => call(owner, 'PATCH', `/api/mcp-servers/${id}`, body);
    expect((await patch({ url: 'https://evil.example.com/mcp' })).statusCode).toBe(400);
    expect((await patch({ authHeader: 'X-Forward-To-Me' })).statusCode).toBe(400);
    expect((await patch({ url: server.url, enabled: false })).statusCode).toBe(200); // unchanged
    const moved = await patch({
      url: 'https://mcp2.example.com/mcp',
      authSecret: 'Bearer new-9999',
    });
    expect(moved.json()).toMatchObject({
      url: 'https://mcp2.example.com/mcp',
      authSecretHint: '9999',
    });
  });

  it('caps servers per organization', async () => {
    const { owner } = await newOrg();
    for (let i = 0; i < 10; i++) {
      expect((await call(owner, 'POST', '/api/mcp-servers', server)).statusCode).toBe(201);
    }
    expect((await call(owner, 'POST', '/api/mcp-servers', server)).statusCode).toBe(400);
  });

  it('400 on bad input', async () => {
    const { owner } = await newOrg();
    const bad = async (payload: object) =>
      (await call(owner, 'POST', '/api/mcp-servers', { ...server, ...payload })).statusCode;
    expect(await bad({ url: 'ftp://mcp.example.com' })).toBe(400);
    expect(await bad({ url: 'https://user:pw@mcp.example.com/mcp' })).toBe(400);
    expect(await bad({ allowedTools: ['rm -rf'] })).toBe(400);
    expect(await bad({ authHeader: 'Host' })).toBe(400);
    expect(await bad({ authHeader: 'Bad Header' })).toBe(400);
    expect(await bad({ authHeader: undefined })).toBe(400); // a secret needs a header
    expect(await bad({ name: '' })).toBe(400);
    expect(await bad({ purposes: [] })).toBe(400);
    expect(await bad({ purposes: ['judge'] })).toBe(400);
  });

  it('401 without a session, 403 for members, keys need the scope', async () => {
    const { owner, org } = await newOrg();
    expect((await call(null, 'GET', '/api/mcp-servers')).statusCode).toBe(401);
    const m = await signUp();
    await auth.api.addMember({ body: { userId: m.id, organizationId: org, role: 'member' } });
    await call(m, 'POST', '/api/auth/organization/set-active', { organizationId: org });
    expect((await call(m, 'GET', '/api/mcp-servers')).statusCode).toBe(403);
    expect((await call(m, 'POST', '/api/mcp-servers', server)).statusCode).toBe(403);

    const keyRes = await call(owner, 'POST', '/api/api-keys', {
      name: 'ci',
      scopes: ['mcp_servers:read'],
      expiresInDays: null,
    });
    expect(keyRes.statusCode, keyRes.body).toBe(201);
    const withKey = (method: Method, url: string, payload?: object) =>
      app.inject({
        method,
        url,
        remoteAddress: ip(),
        headers: { authorization: `Bearer ${keyRes.json().key}` },
        ...(payload && { payload }),
      });
    expect((await withKey('GET', '/api/mcp-servers')).statusCode).toBe(200);
    expect((await withKey('POST', '/api/mcp-servers', server)).statusCode).toBe(403);
  });

  it('isolates organizations: 404 across tenants', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const own = (await call(a.owner, 'POST', '/api/mcp-servers', server)).json();
    expect((await call(b.owner, 'GET', '/api/mcp-servers')).json()).toEqual([]);
    const other = await call(b.owner, 'PATCH', `/api/mcp-servers/${own.id}`, { enabled: false });
    expect(other.statusCode).toBe(404);
    expect((await call(b.owner, 'DELETE', `/api/mcp-servers/${own.id}`)).statusCode).toBe(404);
  });

  it('flag off: 404, nothing stored', async () => {
    const { owner, org } = await newOrg();
    withFlag(false);
    try {
      expect((await call(owner, 'GET', '/api/mcp-servers')).statusCode).toBe(404);
      expect((await call(owner, 'POST', '/api/mcp-servers', server)).statusCode).toBe(404);
    } finally {
      withFlag(true);
    }
    expect(await withOrg(db, org, (tx) => tx.select().from(mcpServers))).toEqual([]);
  });
});
