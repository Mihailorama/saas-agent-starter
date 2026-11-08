// Shared by the API tests: sign-in (and sign-up on first use) with an e-mail code.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { auth } from '../src/auth.ts';
import { allowedOrigins } from '../src/env.ts';

const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
export const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/**
 * POST /api/auth/sign-in/email-otp with a valid code. The code comes from Better Auth's
 * server-only createVerificationOTP (no HTTP route, so production is unchanged); the mailed
 * path itself is tested in api.test.ts and the e2e specs. New accounts are named `T`.
 */
export async function codeSignIn(app: FastifyInstance, email: string, cookie = '') {
  const otp = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email-otp',
    remoteAddress: ip(),
    headers: { origin: allowedOrigins[0]!, ...(cookie && { cookie }) },
    payload: { email, otp, name: 'T' },
  });
}

/** A signed-in user (created now unless `email` already has an account). */
export async function signUp(app: FastifyInstance, email = `${randomUUID()}@example.com`) {
  const res = await codeSignIn(app, email);
  expect(res.statusCode, res.body).toBe(200);
  return { id: res.json().user.id as string, email, cookie: cookieOf(res) };
}
