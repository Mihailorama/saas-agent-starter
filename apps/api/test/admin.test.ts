// Operator console (docs/admin.md): access, suspension, limits, user actions, "view as user",
// audit rows and the one RLS exception.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { auditLog, rewardGrants, session, user as users, withOperatorRead, withOrg } from '@app/db';
import { and, eq, like } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The operator list is env (read once at import), so set it before the app loads.
const opEmail = `op-${randomUUID()}@example.com`;
process.env.OPERATOR_EMAILS = opEmail.toUpperCase(); // matched case-insensitively
const { buildApp } = await import('../src/app.ts');
const { db, pool } = await import('../src/db.ts');
const { allowedOrigins } = await import('../src/env.ts');
const { closeTemporal } = await import('../src/temporal.ts');
const { syncOperators } = await import('../src/operator-guard.ts');
const { signUp: codeSignUp } = await import('./sign-in.ts');

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;

afterAll(async () => {
  await app.close();
  await closeTemporal();
  await pool.end();
});

/** A browser's cookie jar: applies Set-Cookie (incl. expiry) to the previous cookie header. */
function jar(res: LightMyRequestResponse, prev = '') {
  const map = new Map(
    prev
      .split('; ')
      .filter(Boolean)
      .map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)] as const),
  );
  for (const c of res.cookies as { name: string; value: string; maxAge?: number }[]) {
    if (c.maxAge === 0 || c.value === '') map.delete(c.name);
    else map.set(c.name, c.value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

type Browser = { id: string; email: string; cookie: string };
async function call(
  b: { cookie: string } | null,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) {
  const res = await app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, ...(b?.cookie && { cookie: b.cookie }), ...headers },
    ...(payload && { payload }),
  });
  if (b) b.cookie = jar(res, b.cookie);
  return res;
}
const get = (b: { cookie: string } | null, url: string, headers?: Record<string, string>) =>
  call(b, 'GET', url, undefined, headers);
const post = (b: { cookie: string } | null, url: string, payload: object = {}) =>
  call(b, 'POST', url, payload);

const signUp = (email?: string): Promise<Browser> => codeSignUp(app, email);

async function createOrg(b: Browser) {
  const res = await post(b, '/api/auth/organization/create', { name: 'Acme', slug: randomUUID() });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; slug: string };
}

/** TOTP on, as the security page does it (the code check itself is covered in mfa.test.ts). */
async function enrolTotp(b: Browser) {
  const { totpURI } = (await post(b, '/api/auth/two-factor/enable')).json();
  const code = (OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP).generate();
  expect((await post(b, '/api/auth/two-factor/verify-totp', { code })).statusCode).toBe(200);
}

const operatorRows = (orgId: string, action: string) =>
  withOrg(db, orgId, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action))),
  );

let op: Browser;
let owner: Browser;
let org: { id: string; slug: string };

beforeAll(async () => {
  op = await signUp(opEmail);
  owner = await signUp();
  org = await createOrg(owner);
}, 20_000); // slow while the other test files run in parallel

describe('operator access', () => {
  it('needs the listed account, synced role, TOTP and a fresh session', async () => {
    expect((await get(null, '/api/admin/orgs')).statusCode).toBe(401);
    // Listed: the role is applied on the first request (or by the sync), but TOTP is required.
    expect((await get(op, '/api/admin/me')).json()).toEqual({
      error: 'operators need two-factor authentication',
    });
    expect((await db.select().from(users).where(eq(users.id, op.id)))[0]?.role).toBe('operator');
    await enrolTotp(op);
    expect((await get(op, '/api/admin/me')).json()).toMatchObject({ id: op.id });

    // An old session is not enough: sign in again.
    const age = (createdAt: Date) =>
      db.update(session).set({ createdAt }).where(eq(session.userId, op.id));
    await age(new Date(Date.now() - 2 * 3600_000));
    expect((await get(op, '/api/admin/me')).statusCode).toBe(401);
    await age(new Date());
    expect((await get(op, '/api/admin/me')).statusCode).toBe(200);
  });

  it('the sync removes the role from accounts no longer listed; the role alone is nothing', async () => {
    const stale = await signUp();
    await enrolTotp(stale);
    await db.update(users).set({ role: 'operator' }).where(eq(users.id, stale.id));
    expect((await get(stale, '/api/admin/me')).statusCode).toBe(403);
    expect((await syncOperators()).demoted).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(users).where(eq(users.id, stale.id)))[0]?.role).toBe('user');
    expect((await db.select().from(users).where(eq(users.id, op.id)))[0]?.role).toBe('operator');
  });

  it('org owners get 403 on every operator route, also with 2FA', async () => {
    await enrolTotp(owner);
    const routes: [string, string, object?][] = [
      ['GET', '/api/admin/orgs'],
      ['GET', `/api/admin/orgs/${org.id}`],
      ['GET', '/api/admin/users'],
      ['POST', `/api/admin/orgs/${org.id}/suspend`, { reason: 'test' }],
      ['PATCH', `/api/admin/orgs/${org.id}/limits`, { reason: 'test', seats: 5 }],
      ['POST', `/api/admin/users/${owner.id}/revoke-sessions`, { reason: 'test' }],
      ['POST', `/api/admin/users/${op.id}/impersonate`, { reason: 'test' }],
    ];
    for (const [method, url, payload] of routes) {
      const res = await call(owner, method as 'GET', url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // The admin plugin's own endpoints are closed for everyone, operators included.
    expect((await post(op, '/api/auth/admin/list-users')).statusCode).toBe(404);
    expect(
      (await post(op, '/api/auth/admin/set-role', { userId: owner.id, role: 'operator' }))
        .statusCode,
    ).toBe(404);
  });

  it('the admin plugin endpoints stay closed for any URL spelling', async () => {
    const body = { userId: owner.id, role: 'operator' };
    for (const url of [
      '/api/auth/admin/list-users',
      '//api/auth/admin/list-users',
      '/api//auth/admin/list-users',
      '/api/auth//admin/list-users',
      '/api/auth/%61dmin/list-users',
      '/api/auth/admin%2Flist-users',
      '/api/auth/admin/list%2Dusers',
      '/api/%61uth/admin/list-users',
      '/api/auth/./admin/list-users',
      '/api/auth/x/../admin/list-users',
      '/api/auth/admin/set-role',
      '/api/auth/%61dmin/set-role',
      '/api/auth/api-key/list',
      '/api/auth/%61pi-key/list',
    ]) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await call(op, method, url, method === 'POST' ? body : undefined);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
    }
    expect((await db.select().from(users).where(eq(users.id, owner.id)))[0]?.role).not.toBe(
      'operator',
    );
  });
});

describe('organizations', () => {
  it('lists and shows an organization; viewing it is audit-logged', async () => {
    const list = await get(op, `/api/admin/orgs?q=${org.slug}`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      total: 1,
      items: [{ id: org.id, members: 1, planId: 'free', suspended: false }],
    });
    expect(list.json().items[0].llmSpend).toEqual(
      expect.arrayContaining([expect.objectContaining({ spent: 0, limit: 1 })]),
    );
    const detail = await get(op, `/api/admin/orgs/${org.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      members: [{ userId: owner.id, role: 'owner', twoFactor: true }],
      usage: { seats: { used: 1, limit: 3, max: 5 } },
      subscription: null,
    });
    const viewed = await operatorRows(org.id, 'operator.org.viewed');
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({ actorId: op.id });
    expect((await get(op, `/api/admin/orgs/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('suspend blocks the org for sessions and API keys; unsuspend restores it', async () => {
    const created = await post(owner, '/api/api-keys', {
      name: 'ci',
      scopes: ['projects:read'],
      expiresInDays: null,
    });
    expect(created.statusCode).toBe(201);
    const bearer = { authorization: `Bearer ${created.json().key}` };
    expect((await get(null, '/api/projects', bearer)).statusCode).toBe(200);

    // A reason is required.
    expect((await post(op, `/api/admin/orgs/${org.id}/suspend`, {})).statusCode).toBe(400);
    expect(
      (await post(op, `/api/admin/orgs/${org.id}/suspend`, { reason: 'chargeback fraud' }))
        .statusCode,
    ).toBe(204);
    expect(
      (await post(op, `/api/admin/orgs/${org.id}/suspend`, { reason: 'again' })).statusCode,
    ).toBe(409);

    const blocked = { error: 'organization suspended' };
    expect((await get(owner, '/api/projects')).json()).toEqual(blocked);
    expect((await get(null, '/api/projects', bearer)).json()).toEqual(blocked);
    const enter = await post(owner, '/api/auth/organization/set-active', {
      organizationId: org.id,
    });
    expect(enter.statusCode).toBe(403);
    expect(enter.json()).toMatchObject({ code: 'ORG_SUSPENDED' });
    // The reason is internal: the organization never sees it.
    expect(JSON.stringify((await get(owner, '/api/projects')).json())).not.toContain('chargeback');

    // Data-subject rights outlive the suspension (docs/admin.md): export and deletion still work.
    const exported = await post(owner, '/api/privacy/org/export');
    expect(exported.statusCode, exported.body).toBe(202);
    expect((await post(owner, '/api/privacy/user/export')).statusCode).toBe(202);
    const deletion = await post(owner, '/api/privacy/org/deletion');
    expect(deletion.statusCode, deletion.body).toBe(202);
    expect(
      (await post(owner, `/api/privacy/org/requests/${deletion.json().id}/cancel`)).statusCode,
    ).toBe(200);
    expect((await get(owner, '/api/privacy/org/requests')).statusCode).toBe(200);

    const [row] = await operatorRows(org.id, 'operator.org.suspended');
    expect(row).toMatchObject({ actorId: op.id, reason: 'chargeback fraud', target: org.id });

    expect(
      (await post(op, `/api/admin/orgs/${org.id}/unsuspend`, { reason: 'resolved' })).statusCode,
    ).toBe(204);
    expect((await get(owner, '/api/projects')).statusCode).toBe(200);
    expect((await get(null, '/api/projects', bearer)).statusCode).toBe(200);
    expect(await operatorRows(org.id, 'operator.org.unsuspended')).toHaveLength(1);
  });

  it('overrides limits within config/plans.json only', async () => {
    const patch = (body: object) => call(op, 'PATCH', `/api/admin/orgs/${org.id}/limits`, body);
    expect((await patch({ seats: 4 })).statusCode).toBe(400); // no reason
    expect((await patch({ reason: 'trial', seats: 4, projects: 9 })).statusCode).toBe(204);
    expect((await get(owner, '/api/billing')).json().usage).toMatchObject({
      seats: { limit: 4 },
      projects: { limit: 9 },
    });
    // Free plan: limitsMax seats 5; the LLM limit cannot be raised (llmLimitRaise false).
    expect((await patch({ reason: 'trial', seats: 6 })).json().error).toMatch(/at most 5 seats/);
    expect(
      (await patch({ reason: 'trial', llmSpend: { currency: 'USD', amount: 1 } })).json().error,
    ).toMatch(/does not allow changing the LLM limit/);
    expect((await patch({ reason: 'back to plan', seats: null, projects: null })).statusCode).toBe(
      204,
    );
    expect((await get(owner, '/api/billing')).json().usage.seats.limit).toBe(3);
    const rows = await operatorRows(org.id, 'operator.limits.changed');
    expect(rows.map((r) => r.target).sort()).toEqual([
      'seats=4 projects=9',
      'seats=plan projects=plan',
    ]);
    expect(rows.every((r) => r.actorId === op.id && r.reason)).toBe(true);
  });
});

describe('users', () => {
  it('revokes all sessions of a user', async () => {
    const u = await signUp();
    const uOrg = await createOrg(u);
    expect((await get(u, '/api/auth/get-session')).json()).not.toBeNull();
    expect((await post(op, `/api/admin/users/${u.id}/revoke-sessions`, {})).statusCode).toBe(400);
    expect(
      (await post(op, `/api/admin/users/${u.id}/revoke-sessions`, { reason: 'stolen laptop' }))
        .statusCode,
    ).toBe(204);
    expect((await get(u, '/api/auth/get-session')).json()).toBeNull();
    expect(await operatorRows(uOrg.id, 'operator.user.sessions_revoked')).toMatchObject([
      { actorId: op.id, target: u.id, reason: 'stolen laptop' },
    ]);
    const detail = (await get(op, `/api/admin/users/${u.id}`)).json();
    expect(detail).toMatchObject({ id: u.id, sessions: [], memberships: [{ orgId: uOrg.id }] });
    expect(detail.operatorActions).toMatchObject([{ action: 'operator.user.sessions_revoked' }]);
  });

  it('a user without org gets a platform audit row', async () => {
    const u = await signUp();
    expect(
      (await post(op, `/api/admin/users/${u.id}/revoke-sessions`, { reason: 'stolen laptop' }))
        .statusCode,
    ).toBe(204);
    const rows = await withOperatorRead(db, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.target, u.id), like(auditLog.action, 'operator.%'))),
    );
    expect(rows).toMatchObject([
      { orgId: null, action: 'operator.user.sessions_revoked', actorId: op.id },
    ]);
    expect((await get(op, `/api/admin/users?q=${u.email}`)).json()).toMatchObject({
      total: 1,
      items: [{ id: u.id, emailVerified: true, orgs: 0 }],
    });
  });
});

describe('view as user (impersonation)', () => {
  it('is read-only, time-boxed, audit-logged in the user org, and ends cleanly', async () => {
    const browser = { cookie: op.cookie };
    expect((await post(browser, `/api/admin/users/${owner.id}/impersonate`, {})).statusCode).toBe(
      400,
    );
    expect(
      (await post(browser, `/api/admin/users/${op.id}/impersonate`, { reason: 'self' })).statusCode,
    ).toBe(403); // never another operator (or oneself)
    const started = await post(browser, `/api/admin/users/${owner.id}/impersonate`, {
      reason: 'ticket 42: projects page empty',
      orgId: org.id,
    });
    expect(started.statusCode).toBe(200);
    const minutes = (new Date(started.json().expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThanOrEqual(30);

    const s = (await get(browser, '/api/auth/get-session')).json();
    expect(s).toMatchObject({
      user: { id: owner.id },
      session: { impersonatedBy: op.id, activeOrganizationId: org.id },
    });
    // Reads work, as the user sees them.
    expect((await get(browser, '/api/projects')).statusCode).toBe(200);
    expect((await get(browser, '/api/billing')).statusCode).toBe(200);
    // No change of any kind: our routes and Better Auth's.
    const readOnly = 'read-only while viewing as a user';
    expect((await post(browser, '/api/projects', { name: 'x' })).json()).toEqual({
      error: readOnly,
    });
    expect(
      (await call(browser, 'PUT', '/api/security/policy', { requireTwoFactor: false })).json(),
    ).toEqual({
      error: readOnly,
    });
    for (const url of [
      '/api/auth/organization/update',
      '/api/auth/update-user',
      '/api/auth/two-factor/disable',
    ]) {
      const res = await post(browser, url, { data: { name: 'x' }, name: 'x' });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: 'READ_ONLY' });
    }
    // Main's privacy routes too: no export or deletion in the user's name (one shared guard).
    const requests = async () =>
      (await get(browser, '/api/privacy/user/requests')).json().length +
      (await get(browser, '/api/privacy/org/requests')).json().length;
    const before = await requests();
    for (const url of [
      '/api/privacy/user/export',
      '/api/privacy/user/deletion',
      '/api/privacy/org/export',
      '/api/privacy/org/deletion',
    ]) {
      const res = await post(browser, url);
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toEqual({ error: readOnly });
    }
    expect(await requests()).toBe(before);
    // Not an operator while viewing as someone else, and no support identity in their name.
    expect((await get(browser, '/api/admin/me')).statusCode).toBe(403);
    expect((await get(browser, '/api/support/identity')).statusCode).toBe(403);

    const [startRow] = await operatorRows(org.id, 'operator.impersonation.started');
    expect(startRow).toMatchObject({
      actorId: op.id,
      target: owner.id,
      reason: 'ticket 42: projects page empty',
    });
    // The end is on record from the start: no cleanup job needed when the session just expires.
    expect(startRow?.expiresAt?.toISOString()).toBe(started.json().expiresAt);

    const stopped = await post(browser, '/api/impersonation/stop');
    expect(stopped.json()).toEqual({ userId: owner.id });
    expect((await get(browser, '/api/admin/me')).json()).toMatchObject({ id: op.id });
    expect(await operatorRows(org.id, 'operator.impersonation.ended')).toHaveLength(1);
    // The user's own session list never shows the operator's session.
    const own = await get(owner, '/api/auth/list-sessions');
    expect(own.json().every((x: { impersonatedBy?: string }) => !x.impersonatedBy)).toBe(true);
  });
});

describe('the RLS exception is limited to the operator console', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === 'node_modules' || f === '.venv') return [];
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const root = new URL('../../../', import.meta.url).pathname;
  const sources = [
    ...files(join(root, 'apps/api/src')),
    ...files(join(root, 'packages/db/src')),
    ...files(join(root, 'services/worker-py/worker')),
  ].map((p) => [p.slice(root.length), readFileSync(p, 'utf8')] as const);

  it('only the console routes read through withOperatorRead', () => {
    const callers = sources.filter(([, src]) => /withOperatorRead\(/.test(src)).map(([p]) => p);
    expect(callers.sort()).toEqual([
      'apps/api/src/routes/admin-orgs.ts',
      'apps/api/src/routes/admin-users.ts',
    ]);
  });

  it('nothing else switches roles or names the operator role', () => {
    const hits = sources
      .filter(([, src]) =>
        /app_operator_(read|audit)|OPERATOR_READ_ROLE|PLATFORM_AUDIT_ROLE|\bset\s+(local\s+)?role\b/i.test(
          src,
        ),
      )
      .map(([p]) => p);
    expect(hits.sort()).toEqual([
      'apps/api/src/db.ts',
      'packages/db/src/index.ts',
      'packages/db/src/migrate.ts',
      'packages/db/src/schema.ts', // the platform_audit policy's role
    ]);
  });

  it('only the console writes org-less audit rows (withPlatformAudit)', () => {
    const callers = sources.filter(([, src]) => /withPlatformAudit\(/.test(src)).map(([p]) => p);
    expect(callers.sort()).toEqual([
      'apps/api/src/routes/admin-common.ts',
      'packages/db/src/index.ts', // its definition
    ]);
  });
});

describe('rewards waiting for operators (docs/growth.md)', () => {
  it('shows pending_manual grants on the org page until an operator marks them applied', async () => {
    const [g] = await withOrg(db, org.id, (tx) =>
      tx
        .insert(rewardGrants)
        .values({
          orgId: org.id,
          ruleId: 'team-invite',
          subject: randomUUID(),
          status: 'pending_manual',
          via: 'manual',
          reward: { kind: 'balance_credit', amount: '5.00', currency: 'USD' },
          idempotencyKey: 'reward-x',
        })
        .returning(),
    );
    const pending = async () =>
      ((await get(op, `/api/admin/orgs/${org.id}`)).json().pendingRewards as { key: string }[]).map(
        (r) => r.key,
      );
    expect(await pending()).toContain('reward-x');
    const mark = () =>
      post(op, `/api/admin/orgs/${org.id}/rewards/${g!.id}/applied`, {
        reason: 'credit note CN-1',
      });
    expect((await mark()).statusCode).toBe(204);
    expect(await pending()).not.toContain('reward-x');
    expect((await mark()).statusCode).toBe(404);
    expect((await operatorRows(org.id, 'operator.reward.applied'))[0]).toMatchObject({
      target: g!.id,
      reason: 'credit note CN-1',
    });

    // A reservation stuck for over an hour shows too, and can be released (frees the cap).
    const [stuck] = await withOrg(db, org.id, (tx) =>
      tx
        .insert(rewardGrants)
        .values({
          orgId: org.id,
          ruleId: 'team-invite',
          subject: randomUUID(),
          status: 'reserved',
          reward: { kind: 'balance_credit', amount: '5.00', currency: 'USD' },
          idempotencyKey: 'reward-stuck',
          createdAt: new Date(Date.now() - 2 * 3600_000),
        })
        .returning(),
    );
    expect(await pending()).toContain('reward-stuck');
    const release = () =>
      post(op, `/api/admin/orgs/${org.id}/rewards/${stuck!.id}/release`, { reason: 'stuck' });
    expect((await release()).statusCode).toBe(204);
    expect(await pending()).not.toContain('reward-stuck');
    expect((await release()).statusCode).toBe(404);
  });
});
