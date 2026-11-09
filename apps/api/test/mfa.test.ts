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
import { codeSignIn, signUp as codeSignUp } from './sign-in.ts';

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

type User = {
  id: string;
  email: string;
  cookie: string;
  totp?: OTPAuth.TOTP;
  codes?: string[];
  enrolCode?: string;
};
/** Code of the next 30 s step: still inside the plugin's +-1 window, never used before. */
const nextCode = (totp: OTPAuth.TOTP) => totp.generate({ timestamp: Date.now() + 30_000 });

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

const signUp = (): Promise<User> => codeSignUp(app);

async function createOrg(user: User) {
  const res = await post(user, '/api/auth/organization/create', {
    name: 'Org',
    slug: randomUUID(),
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

/** Enable TOTP the way the security page does: enable -> scan URI -> verify. */
async function enrol(user: User) {
  const enabled = await post(user, '/api/auth/two-factor/enable');
  expect(enabled.statusCode).toBe(200);
  const { totpURI, backupCodes } = enabled.json();
  expect(backupCodes).toHaveLength(10);
  const totp = OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP;
  const enrolCode = totp.generate();
  expect(totp.issuer).toBe('Workspace');
  // Not enabled until a code from the authenticator app proves the scan worked.
  expect((await get(user, '/api/auth/get-session')).json().user.twoFactorEnabled).toBe(false);
  expect(
    (await post(user, '/api/auth/two-factor/verify-totp', { code: enrolCode })).statusCode,
  ).toBe(200);
  expect((await get(user, '/api/auth/get-session')).json().user.twoFactorEnabled).toBe(true);
  Object.assign(user, { totp, codes: backupCodes, enrolCode });
}

/** Email-code step of sign-in: with 2FA on it returns a challenge cookie, not a session. */
async function signInCode(user: User, cookie = '') {
  const res = await codeSignIn(app, user.email, cookie);
  expect(res.statusCode).toBe(200);
  return { browser: { cookie: jar(res, cookie) }, body: res.json() };
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

    const { browser, body } = await signInCode(user);
    expect(body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    expect(browser.cookie).not.toContain('session_token');
    expect(
      (await post(browser, '/api/auth/two-factor/verify-totp', { code: '000000' })).statusCode,
    ).toBe(401);
    // A code works once: the enrolment code (same 30 s step) is refused at the next sign-in.
    const replay = await post(browser, '/api/auth/two-factor/verify-totp', {
      code: user.enrolCode,
    });
    expect(replay.statusCode).toBe(401);
    const ok = await post(browser, '/api/auth/two-factor/verify-totp', {
      code: nextCode(user.totp!),
      trustDevice: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(browser.cookie).toContain('session_token');
    expect(browser.cookie).toContain('trust_device');

    // The trusted device skips the second step; a fresh browser does not.
    const trusted = await signInCode(
      user,
      browser.cookie
        .split('; ')
        .filter((c) => c.includes('trust_device'))
        .join('; '),
    );
    expect(trusted.body.twoFactorRedirect).toBeUndefined();
    expect(trusted.browser.cookie).toContain('session_token');
    expect((await signInCode(user)).body.twoFactorRedirect).toBe(true);
  });

  it('accepts each backup code once', async () => {
    const user = await signUp();
    await enrol(user);
    const [first, second] = user.codes!;

    const a = await signInCode(user);
    expect(
      (await post(a.browser, '/api/auth/two-factor/verify-backup-code', { code: first }))
        .statusCode,
    ).toBe(200);
    expect(a.browser.cookie).toContain('session_token');

    const b = await signInCode(user);
    expect(
      (await post(b.browser, '/api/auth/two-factor/verify-backup-code', { code: first }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(b.browser, '/api/auth/two-factor/verify-backup-code', { code: second }))
        .statusCode,
    ).toBe(200);
  });

  it('needs a recent sign-in for sensitive changes, and audits them', async () => {
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
      const stale = await post(user, url);
      expect(stale.statusCode).toBe(403);
      expect(stale.json().code).toBe('SESSION_NOT_FRESH');
    }
    const stalePasskey = await post(user, '/api/auth/passkey/delete-passkey', { id: 'missing' });
    expect(stalePasskey.json().code).toBe('SESSION_NOT_FRESH');

    await age(1);
    const regenerated = await post(user, '/api/auth/two-factor/generate-backup-codes');
    expect(regenerated.statusCode).toBe(200);
    expect(regenerated.json().backupCodes).not.toEqual(user.codes);
    expect((await post(user, '/api/auth/two-factor/disable')).statusCode).toBe(200);
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
      body: { userId: member.id, organizationId: orgId, role: 'admin' },
    });
    expect(
      (await post(member, '/api/auth/organization/set-active', { organizationId: orgId }))
        .statusCode,
    ).toBe(200);
    const invite = (u: User) =>
      post(u, '/api/auth/organization/invite-member', {
        email: `${randomUUID()}@example.com`,
        role: 'member',
      });

    for (const url of ['/api/projects', '/api/security/policy']) {
      const blocked = await get(member, url);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error).toBe('two-factor authentication required');
    }
    // Better Auth's own organization endpoints follow the same policy (mfa.ts).
    const blockedInvite = await invite(member);
    expect(blockedInvite.statusCode).toBe(403);
    expect(blockedInvite.json().code).toBe('TWO_FACTOR_REQUIRED');
    const blockedRole = await post(member, '/api/auth/organization/update-member-role', {
      memberId: 'any',
      role: 'member',
      organizationId: orgId,
    });
    expect(blockedRole.json().code).toBe('TWO_FACTOR_REQUIRED');
    expect((await invite(owner)).statusCode).toBe(200);

    await enrol(member);
    expect((await get(member, '/api/projects')).statusCode).toBe(200);
    expect((await invite(member)).statusCode).toBe(200);
    expect(
      (await put(member, '/api/security/policy', { requireTwoFactor: false })).statusCode,
    ).toBe(200); // admins with 2FA may change it
  });
});
