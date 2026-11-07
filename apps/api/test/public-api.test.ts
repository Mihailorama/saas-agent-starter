// Public API: organization API keys (auth, scopes, revoke, tenancy, rate limit) and the webhook
// management routes + publishEvent(). Delivery itself is tested in services/worker-py.
import { randomUUID } from 'node:crypto';
import {
  auditLog,
  organization,
  user,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  withOrg,
} from '@app/db';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

// Small per-key limit so the test can hit it; set before the app reads its env.
process.env.API_KEY_RATE_LIMIT_PER_MINUTE = '25';
const { buildApp } = await import('../src/app.ts');
const { auth } = await import('../src/auth.ts');
const { db, pool } = await import('../src/db.ts');
const { allowedOrigins } = await import('../src/env.ts');
const { closeTemporal, temporal } = await import('../src/temporal.ts');

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;

afterAll(async () => {
  await app.close();
  await closeTemporal();
  await pool.end();
});

type User = { id: string; cookie: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Signs up and signs in. The address is marked verified in the DB: the mailed confirmation
 * flow itself is covered in api.test.ts. */
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
  expect(signedIn.statusCode).toBe(200);
  return {
    id: res.json().user.id,
    cookie: signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
  };
}

const call = (user: User | null, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, ...(user && { cookie: user.cookie }) },
    ...(payload && { payload }),
  });

/** What an API client does: bearer key, no cookie, no Origin. */
const withKey = (key: string, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { authorization: `Bearer ${key}` },
    ...(payload && { payload }),
  });

async function newOrg(): Promise<{ owner: User; org: string }> {
  const owner = await signUp();
  const res = await call(owner, 'POST', '/api/auth/organization/create', {
    name: 'Org',
    slug: randomUUID(),
  });
  expect(res.statusCode).toBe(200);
  return { owner, org: res.json().id };
}

async function addMember(org: string, role: 'member' | 'admin') {
  const user = await signUp();
  await auth.api.addMember({ body: { userId: user.id, organizationId: org, role } });
  await call(user, 'POST', '/api/auth/organization/set-active', { organizationId: org });
  return user;
}

async function createKey(user: User, scopes: string[], expiresInDays: number | null = null) {
  const res = await call(user, 'POST', '/api/api-keys', { name: 'ci', scopes, expiresInDays });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { key: string; apiKey: { id: string; start: string } };
}

describe('API keys', () => {
  it('create (shown once), use, scope checks, last used, revoke, audit log', async () => {
    const { owner, org } = await newOrg();
    const { key, apiKey } = await createKey(owner, ['projects:read'], 30);
    expect(key).toMatch(/^sk_/);
    expect(key.startsWith(apiKey.start)).toBe(true);

    const [listed] = (await call(owner, 'GET', '/api/api-keys')).json();
    expect(listed).toMatchObject({ id: apiKey.id, start: apiKey.start, scopes: ['projects:read'] });
    expect(listed).not.toHaveProperty('key');
    expect(listed.lastUsedAt).toBeNull();
    const days = (Date.parse(listed.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);

    expect((await withKey(key, 'GET', '/api/projects')).json()).toEqual([]);
    const denied = await withKey(key, 'POST', '/api/projects', { name: 'x' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toContain('projects:write');
    // Keys never manage keys, and work only on routes that declare a scope.
    expect((await withKey(key, 'GET', '/api/api-keys')).statusCode).toBe(403);
    expect((await withKey(`${key}x`, 'GET', '/api/projects')).statusCode).toBe(401);
    expect((await withKey('sk_nope', 'GET', '/api/projects')).statusCode).toBe(401);

    const [used] = (await call(owner, 'GET', '/api/api-keys')).json();
    expect(Date.now() - Date.parse(used.lastUsedAt)).toBeLessThan(60_000);

    expect((await call(owner, 'DELETE', `/api/api-keys/${apiKey.id}`)).statusCode).toBe(204);
    expect((await withKey(key, 'GET', '/api/projects')).statusCode).toBe(401);
    expect((await call(owner, 'GET', '/api/api-keys')).json()).toEqual([]);

    const audit = await withOrg(db, org, (tx) => tx.select().from(auditLog));
    expect(audit.map((a) => [a.action, a.target, a.actorId])).toEqual(
      expect.arrayContaining([
        ['POST /api/api-keys', apiKey.id, owner.id],
        ['DELETE /api/api-keys/:id', apiKey.id, owner.id],
      ]),
    );
  });

  it('only admins manage keys; the plugin endpoints are closed; bad input is rejected', async () => {
    const { owner, org } = await newOrg();
    const member = await addMember(org, 'member');
    const admin = await addMember(org, 'admin');
    expect((await call(member, 'GET', '/api/api-keys')).statusCode).toBe(403);
    expect(
      (
        await call(member, 'POST', '/api/api-keys', {
          name: 'x',
          scopes: ['projects:read'],
          expiresInDays: null,
        })
      ).statusCode,
    ).toBe(403);
    const { apiKey } = await createKey(admin, ['projects:read', 'projects:delete']);
    expect((await call(owner, 'GET', '/api/api-keys')).json()).toHaveLength(1);
    expect((await call(member, 'DELETE', `/api/api-keys/${apiKey.id}`)).statusCode).toBe(403);
    for (const body of [
      { name: 'x', scopes: ['everything'], expiresInDays: null },
      { name: 'x', scopes: [], expiresInDays: null },
      { name: 'x', scopes: ['projects:read'], expiresInDays: 400 },
    ]) {
      expect((await call(owner, 'POST', '/api/api-keys', body)).statusCode).toBe(400);
    }
    const direct = await call(owner, 'POST', '/api/auth/api-key/create', { organizationId: org });
    expect(direct.statusCode).toBe(404);
  });

  it('a key acts only in its own organization (RLS) and respects RBAC-mapped scopes', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const { key } = await createKey(a.owner, ['projects:read', 'projects:write', 'ai_calls:read']);

    const created = await withKey(key, 'POST', '/api/projects', { name: 'via key' });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect((await call(a.owner, 'GET', `/api/projects/${project.id}`)).statusCode).toBe(200);
    expect((await call(b.owner, 'GET', `/api/projects/${project.id}`)).statusCode).toBe(404);

    const other = (await call(b.owner, 'POST', '/api/projects', { name: 'b only' })).json();
    expect((await withKey(key, 'GET', `/api/projects/${other.id}`)).statusCode).toBe(404);
    expect(
      (await withKey(key, 'PATCH', `/api/projects/${other.id}`, { name: 'x' })).statusCode,
    ).toBe(404);
    expect(
      (await withKey(key, 'GET', '/api/projects')).json().map((p: { id: string }) => p.id),
    ).toEqual([project.id]);
    expect((await withKey(key, 'GET', `/api/orgs/${a.org}/ai-calls`)).statusCode).toBe(200);
    expect((await withKey(key, 'GET', `/api/orgs/${b.org}/ai-calls`)).statusCode).toBe(403);
    // projects:delete maps to the admin role; this key does not have it.
    expect((await withKey(key, 'DELETE', `/api/projects/${project.id}`)).statusCode).toBe(403);

    // The mutation is audit-logged with the key as actor.
    const audit = await withOrg(db, a.org, (tx) => tx.select().from(auditLog));
    expect(audit.map((x) => x.actorId)).toContain(
      `apikey:${(await call(a.owner, 'GET', '/api/api-keys')).json()[0].id}`,
    );
    await (await temporal()).workflow.getHandle(`project-created-${project.id}`).terminate('test');
    await (await temporal()).workflow.getHandle(`project-created-${other.id}`).terminate('test');
  });

  it('keys are exempt from the org 2FA policy; only a compliant session can mint them', async () => {
    const { owner, org } = await newOrg();
    const { key } = await createKey(owner, ['projects:read']);
    // The org now requires 2FA and the owner has none (ADR 0017).
    await db.update(organization).set({ requireTwoFactor: true }).where(eq(organization.id, org));
    const sessionRead = await call(owner, 'GET', '/api/projects');
    expect(sessionRead.statusCode).toBe(403);
    expect(sessionRead.json().error).toBe('two-factor authentication required');
    const mint = await call(owner, 'POST', '/api/api-keys', {
      name: 'x',
      scopes: ['projects:read'],
      expiresInDays: null,
    });
    expect(mint.statusCode).toBe(403);
    // A key is a machine credential: it keeps working (ADR 0018).
    expect((await withKey(key, 'GET', '/api/projects')).statusCode).toBe(200);
  });

  it('rate limits per key', async () => {
    const { owner } = await newOrg();
    const { key } = await createKey(owner, ['projects:read']);
    const { key: other } = await createKey(owner, ['projects:read']);
    const statuses: number[] = [];
    for (let i = 0; i < 26; i++)
      statuses.push((await withKey(key, 'GET', '/api/projects')).statusCode);
    expect(statuses.slice(0, 25).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await withKey(other, 'GET', '/api/projects')).statusCode).toBe(200);
  });

  it('documents bearer auth and scopes in OpenAPI', async () => {
    const spec = (await app.inject('/api/openapi.json')).json();
    expect(spec.components.securitySchemes.apiKey).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(spec.paths['/api/projects/'].get.security).toEqual([{ apiKey: [] }, { session: [] }]);
    expect(spec.paths['/api/projects/'].get.description).toContain('`projects:read`');
    expect(spec.paths['/api/webhooks/endpoints'].post.description).toContain('`webhooks:write`');
    expect(spec.paths['/api/api-keys/'].get.security).toBeUndefined();
  });
});

describe('webhooks', () => {
  const endpointBody = (eventTypes: string[], url = 'https://hooks.example.com/in') => ({
    url,
    description: 'CI',
    eventTypes,
  });

  it('manages endpoints, publishes subscribed events, lists deliveries, replays', async () => {
    const { owner, org } = await newOrg();
    const created = await call(
      owner,
      'POST',
      '/api/webhooks/endpoints',
      endpointBody(['project.created']),
    );
    expect(created.statusCode, created.body).toBe(201);
    const { endpoint, secret } = created.json();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(endpoint).not.toHaveProperty('secret');
    const other = (
      await call(owner, 'POST', '/api/webhooks/endpoints', endpointBody(['project.deleted']))
    ).json().endpoint;
    const disabled = (
      await call(owner, 'POST', '/api/webhooks/endpoints', {
        ...endpointBody(['project.created']),
        enabled: false,
      })
    ).json().endpoint;
    for (const bad of [
      endpointBody(['project.created'], 'ftp://hooks.example.com'),
      endpointBody(['project.created'], 'https://user:pw@hooks.example.com'),
      endpointBody(['nope.happened']),
      endpointBody([]),
    ]) {
      expect((await call(owner, 'POST', '/api/webhooks/endpoints', bad)).statusCode).toBe(400);
    }
    const types = (await call(owner, 'GET', '/api/webhooks/event-types')).json();
    expect(types.map((t: { type: string }) => t.type)).toContain('project.created');

    const project = (await call(owner, 'POST', '/api/projects', { name: 'Hooked' })).json();
    const events = await withOrg(db, org, (tx) => tx.select().from(webhookEvents));
    expect(events).toHaveLength(1);
    const body = JSON.parse(events[0]!.payload);
    expect(body).toMatchObject({
      type: 'project.created',
      data: { id: project.id, name: 'Hooked' },
    });
    const deliveries = await withOrg(db, org, (tx) => tx.select().from(webhookDeliveries));
    expect(deliveries.map((d) => [d.endpointId, d.status])).toEqual([[endpoint.id, 'pending']]);
    expect([other.id, disabled.id]).not.toContain(deliveries[0]!.endpointId);

    const client = await temporal();
    const run = client.workflow.getHandle(`webhook-event-${events[0]!.id}`);
    expect((await run.describe()).type).toBe('WebhookEventWorkflow');
    await run.terminate('test: no worker');

    const list = (await call(owner, 'GET', '/api/webhooks/deliveries')).json();
    expect(list).toMatchObject({
      total: 1,
      items: [
        { id: deliveries[0]!.id, eventType: 'project.created', status: 'pending', attempts: 0 },
      ],
    });
    const detail = (
      await call(owner, 'GET', `/api/webhooks/deliveries/${deliveries[0]!.id}`)
    ).json();
    expect(detail).toMatchObject({ payload: body, attemptLog: [] });

    const replay = await call(
      owner,
      'POST',
      `/api/webhooks/deliveries/${deliveries[0]!.id}/replay`,
    );
    expect(replay.statusCode).toBe(202);
    const replayRun = client.workflow.getHandle(`webhook-replay-${deliveries[0]!.id}-0`);
    expect((await replayRun.describe()).type).toBe('WebhookEventWorkflow');
    await replayRun.terminate('test: no worker');

    // Secrets are encrypted at rest and never readable through the API again.
    const load = async () =>
      (
        await withOrg(db, org, (tx) =>
          tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id)),
        )
      )[0]!;
    const noPlaintext = (column: string | null, plain: string) => {
      expect(column).toMatch(/^v1:local-dev:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(column).not.toContain(plain.slice('whsec_'.length));
    };
    const before = await load();
    noPlaintext(before.secret, secret);
    expect(
      (await call(owner, 'GET', `/api/webhooks/endpoints/${endpoint.id}/secret`)).statusCode,
    ).toBe(404);
    const rotated = (
      await call(owner, 'POST', `/api/webhooks/endpoints/${endpoint.id}/rotate-secret`)
    ).json();
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(secret);
    const stored = await load();
    noPlaintext(stored.secret, rotated.secret);
    expect(stored.previousSecret).toBe(before.secret); // still encrypted, still signs for 24 h
    expect(stored.previousSecretExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    const patched = await call(owner, 'PATCH', `/api/webhooks/endpoints/${endpoint.id}`, {
      enabled: false,
    });
    expect(patched.json()).toMatchObject({
      enabled: false,
      disabledReason: 'manual',
      eventTypes: ['project.created'],
    });
    // The worker disabled it (410 or too many failures): re-enabling clears that state.
    await withOrg(db, org, (tx) =>
      tx
        .update(webhookEndpoints)
        .set({ disabledReason: 'gone', consecutiveFailures: 7 })
        .where(eq(webhookEndpoints.id, endpoint.id)),
    );
    const listed = (await call(owner, 'GET', '/api/webhooks/endpoints')).json();
    expect(listed.find((e: { id: string }) => e.id === endpoint.id)).toMatchObject({
      id: endpoint.id,
      disabledReason: 'gone',
      consecutiveFailures: 7,
    });
    const reenabled = await call(owner, 'PATCH', `/api/webhooks/endpoints/${endpoint.id}`, {
      enabled: true,
    });
    expect(reenabled.json()).toMatchObject({
      enabled: true,
      disabledReason: null,
      disabledAt: null,
      consecutiveFailures: 0,
    });
    expect((await call(owner, 'DELETE', `/api/webhooks/endpoints/${endpoint.id}`)).statusCode).toBe(
      204,
    );
    expect((await call(owner, 'GET', '/api/webhooks/deliveries')).json().total).toBe(0);
    await client.workflow.getHandle(`project-created-${project.id}`).terminate('test');

    const audit = await withOrg(db, org, (tx) => tx.select().from(auditLog));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'POST /api/webhooks/endpoints',
        'POST /api/webhooks/endpoints/:id/rotate-secret',
        'DELETE /api/webhooks/endpoints/:id',
      ]),
    );
  });

  it('is admin-only, tenant-isolated and scope-checked for API keys', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const endpoint = (
      await call(a.owner, 'POST', '/api/webhooks/endpoints', endpointBody(['project.updated']))
    ).json().endpoint;
    const member = await addMember(a.org, 'member');
    expect((await call(member, 'GET', '/api/webhooks/endpoints')).statusCode).toBe(403);
    expect((await call(b.owner, 'GET', '/api/webhooks/endpoints')).json()).toEqual([]);
    expect(
      (await call(b.owner, 'POST', `/api/webhooks/endpoints/${endpoint.id}/rotate-secret`))
        .statusCode,
    ).toBe(404);

    const { key } = await createKey(a.owner, ['webhooks:read']);
    expect((await withKey(key, 'GET', '/api/webhooks/endpoints')).json()).toHaveLength(1);
    expect(
      (await withKey(key, 'POST', '/api/webhooks/endpoints', endpointBody(['project.created'])))
        .statusCode,
    ).toBe(403);
    expect(
      (await withKey(key, 'POST', `/api/webhooks/endpoints/${endpoint.id}/rotate-secret`))
        .statusCode,
    ).toBe(403);
  });
});
