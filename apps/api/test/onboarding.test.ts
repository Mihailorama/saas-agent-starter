// Onboarding checklist (docs/onboarding.md): GET /api/onboarding behind the `onboarding` flag,
// every item derived from existing data, scoped to the active organization.
import { randomUUID } from 'node:crypto';
import { user } from '@app/db';
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
  await call('POST', '/api/auth/organization/create', cookie, { name: 'Org', slug: randomUUID() });
  return cookie;
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
    expect((await call('GET', '/api/onboarding/', await newOrg())).statusCode).toBe(404);
  });

  it('flag on: 401 without a session', async () => {
    flag(true);
    expect((await call('GET', '/api/onboarding/')).statusCode).toBe(401);
  });

  it('flag on: each item turns done from its own data, per organization', async () => {
    flag(true);
    const a = await newOrg();
    const b = await newOrg();
    const none = {
      org_profile: false,
      first_project: false,
      teammate_invited: false,
      two_factor: false,
      api_key: false,
    };
    expect(await status(a)).toEqual(none);

    for (const [url, body, code] of [
      [
        '/api/auth/organization/update',
        { data: { metadata: { size: '11-50', website: 'https://example.com' } } },
        200,
      ],
      ['/api/projects/', { name: 'P', description: '' }, 201],
      [
        '/api/auth/organization/invite-member',
        { email: `${randomUUID()}@example.com`, role: 'member' },
        200,
      ],
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
});
