import { schema } from '@app/db';
import * as Sentry from '@sentry/node-core';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, organization } from 'better-auth/plugins';
import { db } from './db.ts';
import { type EmailKind, pickLocale, renderEmail } from './email.ts';
import { allowedOrigins, env } from './env.ts';
import { startSendEmail } from './temporal.ts';

/** Renders in the request's language and starts the worker's SendEmailWorkflow; that is all. */
async function sendEmail(
  kind: EmailKind,
  to: string,
  url: string,
  key: string,
  request: Request | undefined,
  vars: { name?: string; org?: string; inviter?: string },
) {
  try {
    const locale = pickLocale(request?.headers.get('accept-language'));
    await startSendEmail({ kind, to, ...(await renderEmail(kind, locale, url, vars)) }, key);
  } catch (err) {
    Sentry.captureException(err); // the message carries no address, token or link
    throw err;
  }
}

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
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: ({ user, url, token }, request) =>
      sendEmail('reset-password', user.email, url, token, request, { name: user.name }),
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true, // an unverified sign-in attempt mails a fresh link
    autoSignInAfterVerification: true,
    sendVerificationEmail: ({ user, url, token }, request) =>
      sendEmail('verify-email', user.email, url, token, request, { name: user.name }),
  },
  plugins: [
    organization({
      // Better Auth gives no link for invitations: the web's accept page (apps/web).
      sendInvitationEmail: (data, request) =>
        sendEmail(
          'invitation',
          data.email,
          `${env.BETTER_AUTH_URL}/accept-invitation/${data.id}`,
          `${data.id}:${new Date(data.invitation.expiresAt).toISOString()}`, // a re-send renews it
          request,
          { org: data.organization.name, inviter: data.inviter.user.name },
        ),
    }),
    ...oidc,
  ],
  // Rate limiting is done by @fastify/rate-limit backed by Redis (shared across replicas).
  rateLimit: { enabled: false },
  advanced: {
    // Mail callbacks run after the response: a reset request answers equally fast whether or
    // not the account exists (no enumeration by timing).
    backgroundTasks: { handler: (task) => void task.catch((err) => Sentry.captureException(err)) },
    useSecureCookies: env.NODE_ENV === 'production',
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
  },
  telemetry: { enabled: false },
});
