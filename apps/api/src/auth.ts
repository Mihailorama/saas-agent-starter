import { schema } from '@app/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, organization } from 'better-auth/plugins';
import { db } from './db.ts';
import { allowedOrigins, env } from './env.ts';

// Optional SSO: set OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET to enable "Sign in with SSO".
const oidc =
  env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
    ? [
        genericOAuth({
          config: [
            {
              providerId: 'oidc',
              clientId: env.OIDC_CLIENT_ID,
              clientSecret: env.OIDC_CLIENT_SECRET,
              discoveryUrl: `${env.OIDC_ISSUER}/.well-known/openid-configuration`,
              scopes: ['openid', 'email', 'profile'],
            },
          ],
        }),
      ]
    : [];

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: allowedOrigins,
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  plugins: [organization(), ...oidc],
  // Rate limiting is done by @fastify/rate-limit backed by Valkey (shared across replicas).
  rateLimit: { enabled: false },
  advanced: {
    useSecureCookies: env.NODE_ENV === 'production',
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
  },
  telemetry: { enabled: false },
});
