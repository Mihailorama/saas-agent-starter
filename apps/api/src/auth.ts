import { schema } from '@app/db';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, organization, twoFactor } from 'better-auth/plugins';
import { db } from './db.ts';
import { allowedOrigins, env } from './env.ts';
import { mfaGuard } from './mfa.ts';

// Optional SSO: set OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET to enable "Sign in with SSO".
// Callback (register it at the IdP): ${BETTER_AUTH_URL}/api/auth/callback/oidc. PKCE is on.
const oidc =
  env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
    ? [
        genericOAuth({
          config: [
            {
              providerId: 'oidc',
              clientId: env.OIDC_CLIENT_ID,
              clientSecret: env.OIDC_CLIENT_SECRET,
              // Issuers often end with '/' (Authentik, Keycloak realms do not): avoid '//.well-known'.
              discoveryUrl: `${env.OIDC_ISSUER.replace(/\/+$/, '')}/.well-known/openid-configuration`,
              scopes: ['openid', 'email', 'profile'],
            },
          ],
        }),
      ]
    : [];
export const ssoEnabled = oidc.length > 0;

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: allowedOrigins,
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  plugins: [
    organization(),
    // 2FA and passkeys (ADR 0017). TOTP + backup codes + trusted devices; passwordless = SSO
    // users may enrol too (a password is still asked whenever the account has one).
    twoFactor({ issuer: env.APP_NAME, allowPasswordless: true }),
    // A passkey sign-in is multi-factor on its own (device + PIN/biometric): no TOTP step.
    passkey({
      rpID: env.PASSKEY_RP_ID ?? new URL(env.BETTER_AUTH_URL).hostname,
      rpName: env.APP_NAME,
      origin: env.PASSKEY_ORIGIN.length ? env.PASSKEY_ORIGIN : new URL(env.BETTER_AUTH_URL).origin,
    }),
    mfaGuard(),
    ...oidc,
  ],
  // Rate limiting is done by @fastify/rate-limit backed by Redis (shared across replicas).
  rateLimit: { enabled: false },
  advanced: {
    useSecureCookies: env.NODE_ENV === 'production',
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
  },
  telemetry: { enabled: false },
});
