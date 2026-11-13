// Staff single sign-on (docs/sso.md): the app as the tools' OpenID Connect provider. The whole
// authorization code flow as a tool runs it, operator-only tokens, closed client management.
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Env is read once at import: the operator list and one tool client, before the app loads.
const opEmail = `sso-op-${randomUUID()}@example.com`;
process.env.OPERATOR_EMAILS = opEmail;
const secret = 'local-dev-grafana-sso-secret';
const redirectUri = 'http://localhost:3001/login/generic_oauth';
process.env.SSO_GRAFANA_SECRET = secret;
process.env.SSO_GRAFANA_REDIRECT_URIS = redirectUri;
const { buildApp } = await import('../src/app.ts');
const { db, pool } = await import('../src/db.ts');
const { user } = await import('@app/db');
const { eq } = await import('drizzle-orm');
const { allowedOrigins, env } = await import('../src/env.ts');
const { closeTemporal } = await import('../src/temporal.ts');
const { syncOperators } = await import('../src/operator-guard.ts');
const { syncSsoClients } = await import('../src/sso.ts');
const { signUp } = await import('./sign-in.ts');

const app = await buildApp();
const origin = allowedOrigins[0]!;
const basic = `Basic ${Buffer.from(`grafana:${secret}`).toString('base64')}`;

afterAll(async () => {
  await app.close();
  await closeTemporal();
  await pool.end();
});

const authorize = (cookie: string, params: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'grafana',
      redirect_uri: redirectUri,
      scope: 'openid email profile groups',
      state: 'st-1',
      nonce: 'n-1',
      ...params,
    })}`,
    headers: { origin, accept: 'text/html', ...(cookie && { cookie }) },
  });

const location = (res: LightMyRequestResponse) =>
  new URL(String(res.headers.location ?? JSON.parse(res.body || '{}').url), env.BETTER_AUTH_URL);

const token = (code: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/oauth2/token',
    headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

const part = (jwt: string, i: number) =>
  JSON.parse(Buffer.from(jwt.split('.')[i]!, 'base64url').toString());

let operator = '';
let operatorId = '';
/** Two-factor as the operator console requires it (enrolment itself is tested in mfa.test.ts). */
const setTwoFactor = (on: boolean) =>
  db.update(user).set({ twoFactorEnabled: on }).where(eq(user.id, operatorId));
let member = '';
beforeAll(async () => {
  await syncSsoClients();
  const op = await signUp(app, opEmail);
  operator = op.cookie;
  await syncOperators();
  operatorId = op.id;
  await setTwoFactor(true);
  member = (await signUp(app)).cookie;
});

describe('staff single sign-on', () => {
  it('publishes OpenID Connect discovery with RS256 keys', async () => {
    const res = await app.inject({ url: '/api/auth/.well-known/openid-configuration' });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d.issuer).toBeTruthy();
    expect(d.id_token_signing_alg_values_supported).toContain('RS256');
    expect(d.scopes_supported).toContain('groups');
    const jwks = await app.inject({ url: new URL(d.jwks_uri).pathname });
    expect(jwks.statusCode).toBe(200);
    expect(jwks.json().keys[0].kty).toBe('RSA');
  });

  it('refuses an operator without two-factor', async () => {
    await setTwoFactor(false);
    const t = await token(location(await authorize(operator)).searchParams.get('code')!);
    expect(t.statusCode, t.body).toBe(403);
    await setTwoFactor(true);
  });

  it('gives an operator a signed id token and userinfo with the operators group', async () => {
    const res = await authorize(operator);
    const back = location(res);
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
    expect(back.searchParams.get('state')).toBe('st-1');
    const code = back.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const t = await token(code);
    expect(t.statusCode, t.body).toBe(200);
    const { id_token, access_token } = t.json();
    const claims = part(id_token, 1);
    expect(claims).toMatchObject({ aud: 'grafana', nonce: 'n-1', groups: ['operators'] });

    // Verified the way a tool does: the key from JWKS by kid, RS256 over header.payload.
    const { kid } = part(id_token, 0);
    const jwk = (await app.inject({ url: '/api/auth/jwks' }))
      .json()
      .keys.find((k: { kid: string }) => k.kid === kid);
    const [h, p, sig] = id_token.split('.');
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);

    const info = await app.inject({
      url: '/api/auth/oauth2/userinfo',
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(info.statusCode, info.body).toBe(200);
    expect(info.json()).toMatchObject({ email: opEmail, groups: ['operators'] });
  });

  it('issues no token to a user who is not an operator', async () => {
    const res = await authorize(member);
    // The code is issued (the session is valid), the token is not: the claims hook refuses it.
    const code = location(res).searchParams.get('code')!;
    const t = await token(code);
    expect(t.statusCode, t.body).toBe(403);
    expect(t.json().id_token).toBeUndefined();
  });

  it('sends a signed-out visitor to sign-in with the request, never to a foreign redirect', async () => {
    const out = location(await authorize(''));
    expect(out.pathname).toBe('/sign-in');
    expect(out.searchParams.get('client_id')).toBe('grafana');

    const foreign = await authorize(operator, { redirect_uri: 'https://evil.example.com/cb' });
    expect(String(foreign.headers.location ?? '')).not.toContain('evil.example.com');
  });

  it('allows offline_access, as Vaultwarden requests it, and returns a refresh token', async () => {
    const res = await authorize(operator, { scope: 'openid email profile offline_access' });
    const code = location(res).searchParams.get('code');
    expect(code, String(res.headers.location)).toBeTruthy();
    const t = await token(code!);
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json().refresh_token).toBeTruthy();
  });

  it('refuses a wrong client secret', async () => {
    const code = location(await authorize(operator)).searchParams.get('code')!;
    const t = await app.inject({
      method: 'POST',
      url: '/api/auth/oauth2/token',
      headers: {
        authorization: `Basic ${Buffer.from('grafana:wrong').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });
    expect(t.statusCode).toBe(401);
  });

  it('keeps client management closed: clients come only from the environment', async () => {
    for (const url of ['/api/auth/oauth2/create-client', '/api/auth/oauth2/register']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { origin, cookie: operator },
        payload: { redirect_uris: ['https://evil.example.com/cb'] },
      });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
