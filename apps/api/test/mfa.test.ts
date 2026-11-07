// 2FA, backup codes, re-auth, audit and the org 2FA policy (ADR 0017). Passkeys: e2e.
import { randomUUID } from 'node:crypto';
import { auditLog, session, withOrg } from '@app/db';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import * as OTPAuth from 'otpauth';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { auth } from '../src/auth.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins } from '../src/env.ts';
import { closeTemporal } from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const password = 'correct-horse-battery';
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

type User = { id: string; email: string; cookie: string; totp?: OTPAuth.TOTP; codes?: string[] };

async function post(user: { cookie: string } | null, url: string, payload: object = {}) {
  const res = await app.inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    headers: { origin, ...(user && { cookie: user.cookie }) },
    payload,
  });
  if (user) user.cookie = jar(res, user.cookie);
  return res;
}
const get = (user: User, url: string) =>
  app.inject({ method: 'GET', url, remoteAddress: ip(), headers: { cookie: user.cookie } });
const put = (user: User, url: string, payload: object) =>
  app.inject({
    method: 'PUT',
    url,
    remoteAddress: ip(),
    headers: { origin, cookie: user.cookie },
    payload,
  });

async function signUp(): Promise<User> {
  const email = `${randomUUID()}@example.com`;
  const res = await post(null, '/api/auth/sign-up/email', { email, password, name: 'T' });
  expect(res.statusCode).toBe(200);
  return { id: res.json().user.id, email, cookie: jar(res) };
}

async function createOrg(user: User) {
  const res = await post(user, '/api/auth/organization/create', {
    name: 'Org',
    slug: randomUUID(),
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

/** Enable TOTP the way the security page does: enable (password) -> scan URI -> verify. */
async function enrol(user: User) {
  const enabled = await post(user, '/api/auth/two-factor/enable', { password });
  expect(enabled.statusCode).toBe(200);
  const { totpURI, backupCodes } = enabled.json();
  expect(backupCodes).toHaveLength(10);
  const totp = OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP;
  expect(totp.issuer).toBe('Workspace');
  // Not enabled until a code from the authenticator app proves the scan worked.
  expect((await get(user, '/api/auth/get-session')).json().user.twoFactorEnabled).toBe(false);
  expect(
    (await post(user, '/api/auth/two-factor/verify-totp', { code: totp.generate() })).statusCode,
  ).toBe(200);
  expect((await get(user, '/api/auth/get-session')).json().user.twoFactorEnabled).toBe(true);
  Object.assign(user, { totp, codes: backupCodes });
}

/** Password step of sign-in: with 2FA on it returns a challenge cookie, not a session. */
async function signInPassword(user: User, cookie = '') {
  const browser = { cookie };
  const res = await post(browser, '/api/auth/sign-in/email', { email: user.email, password });
  expect(res.statusCode).toBe(200);
  return { browser, body: res.json() };
}

const actions = async (orgId: string, actorId: string) =>
  (
    await withOrg(db, orgId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.actorId, actorId)),
    )
  ).map((a) => a.action);

describe('two-factor (TOTP)', () => {
  it('enrols, challenges at sign-in and trusts a device', async () => {
    const user = await signUp();
    const orgId = await createOrg(user);
    await enrol(user);
    expect(await actions(orgId, user.id)).toContain('two_factor.enabled');

    const { browser, body } = await signInPassword(user);
    expect(body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    expect(browser.cookie).not.toContain('session_token');
    expect(
      (await post(browser, '/api/auth/two-factor/verify-totp', { code: '000000' })).statusCode,
    ).toBe(401);
    const ok = await post(browser, '/api/auth/two-factor/verify-totp', {
      code: user.totp!.generate(),
      trustDevice: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(browser.cookie).toContain('session_token');
    expect(browser.cookie).toContain('trust_device');

    // The trusted device skips the second step; a fresh browser does not.
    const trusted = await signInPassword(
      user,
      browser.cookie
        .split('; ')
        .filter((c) => c.includes('trust_device'))
        .join('; '),
    );
    expect(trusted.body.twoFactorRedirect).toBeUndefined();
    expect(trusted.browser.cookie).toContain('session_token');
    expect((await signInPassword(user)).body.twoFactorRedirect).toBe(true);
  });

  it('accepts each backup code once', async () => {
    const user = await signUp();
    await enrol(user);
    const [first, second] = user.codes!;

    const a = await signInPassword(user);
    expect(
      (await post(a.browser, '/api/auth/two-factor/verify-backup-code', { code: first }))
        .statusCode,
    ).toBe(200);
    expect(a.browser.cookie).toContain('session_token');

    const b = await signInPassword(user);
    expect(
      (await post(b.browser, '/api/auth/two-factor/verify-backup-code', { code: first }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(b.browser, '/api/auth/two-factor/verify-backup-code', { code: second }))
        .statusCode,
    ).toBe(200);
  });

  it('needs a recent sign-in and the password for sensitive changes, and audits them', async () => {
    const user = await signUp();
    const orgId = await createOrg(user);
    await enrol(user);
    const age = (minutes: number) =>
      db
        .update(session)
        .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
        .where(eq(session.userId, user.id));

    await age(30);
    for (const url of [
      '/api/auth/two-factor/generate-backup-codes',
      '/api/auth/two-factor/disable',
    ]) {
      const stale = await post(user, url, { password });
      expect(stale.statusCode).toBe(403);
      expect(stale.json().code).toBe('SESSION_NOT_FRESH');
    }
    const stalePasskey = await post(user, '/api/auth/passkey/delete-passkey', { id: 'missing' });
    expect(stalePasskey.json().code).toBe('SESSION_NOT_FRESH');

    await age(1);
    const regenerated = await post(user, '/api/auth/two-factor/generate-backup-codes', {
      password,
    });
    expect(regenerated.statusCode).toBe(200);
    expect(regenerated.json().backupCodes).not.toEqual(user.codes);
    expect(
      (await post(user, '/api/auth/two-factor/disable', { password: 'wrong-password-123' }))
        .statusCode,
    ).toBe(400);
    expect((await post(user, '/api/auth/two-factor/disable', { password })).statusCode).toBe(200);
    expect((await get(user, '/api/auth/get-session')).json().user.twoFactorEnabled).toBe(false);

    expect(await actions(orgId, user.id)).toEqual(
      expect.arrayContaining([
        'two_factor.enabled',
        'two_factor.backup_codes_regenerated',
        'two_factor.disabled',
      ]),
    );
    // Rejected attempts leave no audit row.
    expect((await actions(orgId, user.id)).filter((a) => a === 'two_factor.disabled')).toHaveLength(
      1,
    );
  });
});

describe('org policy: require 2FA for all members', () => {
  it('is set by admins with 2FA and blocks members without it', async () => {
    const owner = await signUp();
    const orgId = await createOrg(owner);
    expect((await get(owner, '/api/security/policy')).json()).toEqual({ requireTwoFactor: false });
    // An admin without 2FA would lock themselves out.
    expect((await put(owner, '/api/security/policy', { requireTwoFactor: true })).statusCode).toBe(
      400,
    );
    await enrol(owner);
    expect((await put(owner, '/api/security/policy', { requireTwoFactor: true })).json()).toEqual({
      requireTwoFactor: true,
    });
    expect(await actions(orgId, owner.id)).toContain('PUT /api/security/policy');

    const member = await signUp();
    await auth.api.addMember({
      body: { userId: member.id, organizationId: orgId, role: 'member' },
    });
    await post(member, '/api/auth/organization/set-active', { organizationId: orgId });

    for (const url of ['/api/projects', '/api/security/policy']) {
      const blocked = await get(member, url);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error).toBe('two-factor authentication required');
    }
    await enrol(member);
    expect((await get(member, '/api/projects')).statusCode).toBe(200);
    expect(
      (await put(member, '/api/security/policy', { requireTwoFactor: false })).statusCode,
    ).toBe(403);
  });
});
