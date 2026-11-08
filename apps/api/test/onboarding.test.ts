// Onboarding checklist (docs/onboarding.md): GET /api/onboarding behind the `onboarding` flag,
// every item derived from existing data, scoped to the active organization.
import { randomUUID } from 'node:crypto';
import { member, user } from '@app/db';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { closeTemporal } from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
// FLAGS_ON is read per request: switch the flag per test.
const flag = (on: boolean) =>
  env.FLAGS_ON.splice(0, env.FLAGS_ON.length, ...(on ? ['onboarding'] : []));

afterAll(async () => {
  flag(false);
  await app.close();
  await closeTemporal();
  await pool.end();
});

const call = (method: 'GET' | 'POST', url: string, cookie?: string, payload?: object) =>
  app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, ...(cookie && { cookie }) },
    ...(payload && { payload }),
  });

async function newOrg() {
  const credentials = { email: `${randomUUID()}@example.com`, password: 'correct-horse-battery' };
  await call('POST', '/api/auth/sign-up/email', undefined, { ...credentials, name: 'T' });
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, credentials.email));
  const signedIn = await call('POST', '/api/auth/sign-in/email', undefined, credentials);
  const cookie = signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const org = await call('POST', '/api/auth/organization/create', cookie, {
    name: 'Org',
    slug: randomUUID(),
  });
  return { cookie, orgId: org.json().id as string, userId: signedIn.json().user.id as string };
}

const status = async (cookie: string) => {
  const res = await call('GET', '/api/onboarding/', cookie);
  expect(res.statusCode, res.body).toBe(200);
  return Object.fromEntries(
    (res.json().items as { id: string; done: boolean }[]).map((i) => [i.id, i.done]),
  );
};

describe('onboarding checklist', () => {
  it('flag off: 404', async () => {
    flag(false);
    expect((await call('GET', '/api/onboarding/', (await newOrg()).cookie)).statusCode).toBe(404);
  });

  it('flag on: 401 without a session', async () => {
    flag(true);
    expect((await call('GET', '/api/onboarding/')).statusCode).toBe(401);
  });

  it('flag on: each item turns done from its own data, per organization', async () => {
    flag(true);
    const a = (await newOrg()).cookie;
    const b = (await newOrg()).cookie;
    const none = {
      org_profile: false,
      first_project: false,
      teammate_invited: false,
      two_factor: false,
      api_key: false,
    };
    expect(await status(a)).toEqual(none);

    // A canceled invitation does not count; a pending one does.
    const invite = () =>
      call('POST', '/api/auth/organization/invite-member', a, {
        email: `${randomUUID()}@example.com`,
        role: 'member',
      });
    const canceled = await invite();
    expect(canceled.statusCode, canceled.body).toBe(200);
    await call('POST', '/api/auth/organization/cancel-invitation', a, {
      invitationId: canceled.json().id,
    });
    expect((await status(a)).teammate_invited).toBe(false);
    expect((await invite()).statusCode).toBe(200);

    for (const [url, body, code] of [
      [
        '/api/auth/organization/update',
        { data: { metadata: { size: '11-50', website: 'https://example.com' } } },
        200,
      ],
      ['/api/projects/', { name: 'P', description: '' }, 201],
      ['/api/api-keys', { name: 'k', scopes: ['projects:read'], expiresInDays: null }, 201],
    ] as const) {
      const res = await call('POST', url, a, body);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(code);
    }

    expect(await status(a)).toEqual({
      ...none,
      org_profile: true,
      first_project: true,
      teammate_invited: true,
      api_key: true,
    });
    expect(await status(b)).toEqual(none); // nothing leaks across organizations
  });

  it('organization metadata: only known keys, a size from the list and an http(s) website', async () => {
    const { cookie } = await newOrg();
    const update = (metadata: object) =>
      call('POST', '/api/auth/organization/update', cookie, { data: { metadata } });
    for (const bad of [
      { size: 'huge' },
      { website: 'javascript:alert(1)' },
      { website: `https://example.com/${'a'.repeat(200)}` },
      { size: '1-10', plan: 'enterprise' },
    ]) {
      expect((await update(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await update({ size: '1-10' })).statusCode).toBe(200);
    const created = await call('POST', '/api/auth/organization/create', cookie, {
      name: 'Org',
      slug: randomUUID(),
      metadata: { tier: 'gold' },
    });
    expect(created.statusCode).toBe(400);
  });

  it('flag on: a member gets only the items a member can complete', async () => {
    flag(true);
    const owner = await newOrg();
    const m = await newOrg();
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: owner.orgId,
      userId: m.userId,
      role: 'member',
      createdAt: new Date(),
    });
    const active = await call('POST', '/api/auth/organization/set-active', m.cookie, {
      organizationId: owner.orgId,
    });
    expect(active.statusCode, active.body).toBe(200);
    expect(await status(m.cookie)).toEqual({ first_project: false, two_factor: false });
    // The second member also completes the owner's "teammate" item.
    expect((await status(owner.cookie)).teammate_invited).toBe(true);
  });
});
