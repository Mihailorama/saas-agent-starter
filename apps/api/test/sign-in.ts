// Shared by the API tests: sign-in (and sign-up on first use) with an e-mail code.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { auth } from '../src/auth.ts';
import { allowedOrigins } from '../src/env.ts';
import { LEGAL } from '../src/legal.ts';

const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
export const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/**
 * POST /api/auth/sign-in/email-otp with a valid code. The code comes from Better Auth's
 * server-only createVerificationOTP (no HTTP route, so production is unchanged); the mailed
 * path itself is tested in api.test.ts and the e2e specs. New accounts are named `T`.
 */
export async function codeSignIn(
  app: FastifyInstance,
  email: string,
  cookie = '',
  fields: Record<string, unknown> = {}, // sign-up fields, e.g. referralCode
) {
  const otp = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email-otp',
    remoteAddress: ip(),
    headers: { origin: allowedOrigins[0]!, ...(cookie && { cookie }) },
    payload: { email, otp, name: 'T', ...fields },
  });
}

/** Accepts the current terms and privacy versions, as sign-up's last step does (docs/legal.md). */
export async function acceptLegal(app: FastifyInstance, cookie: string, marketingOptIn?: boolean) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/legal/accept',
    remoteAddress: ip(),
    headers: { origin: allowedOrigins[0]!, cookie },
    payload: { terms: LEGAL.terms, privacy: LEGAL.privacy, ageConfirmed: true, marketingOptIn },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * A signed-in user (created now unless `email` already has an account) who accepted the terms,
 * unless `accept: false` (legal.test.ts).
 */
export async function signUp(
  app: FastifyInstance,
  email = `${randomUUID()}@example.com`,
  fields: Record<string, unknown> = {},
  { accept = true } = {},
) {
  const res = await codeSignIn(app, email, '', fields);
  expect(res.statusCode, res.body).toBe(200);
  const cookie = cookieOf(res);
  // A 2FA account gets no session here; its callers sign in again themselves.
  if (accept && cookie.includes('session_token')) await acceptLegal(app, cookie);
  return { id: res.json().user.id as string, email, cookie };
}
