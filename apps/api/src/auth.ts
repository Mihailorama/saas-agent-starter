import { schema } from '@app/db';
import { passkey } from '@better-auth/passkey';
import * as Sentry from '@sentry/node-core';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { admin, genericOAuth, organization, twoFactor } from 'better-auth/plugins';
import { z } from 'zod';
import { apiKeys, operatorAccess, orgAccess } from './access.ts';
import { entitlements } from './billing/entitlements.ts';
import { db } from './db.ts';
import { type EmailKind, pickLocale, renderEmail } from './email.ts';
import { allowedOrigins, env } from './env.ts';
import { mfaGuard } from './mfa.ts';
import { operatorGuard } from './operator-guard.ts';
import { assertAllowedEmail } from './signup-guard.ts';
import { type CrmEvent, startCrmSync, startSendEmail } from './temporal.ts';

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

/** Person / company in the CRM (docs/crm.md). A Temporal outage never blocks a sign-up. */
const crmSync = async (e: CrmEvent) => {
  await startCrmSync(e).catch((err) => Sentry.captureException(err));
};
const personSync = (userId: string) =>
  crmSync({ kind: 'user.created', eventId: `user:${userId}`, userId });

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

/**
 * The only keys an organization's `metadata` may hold (onboarding company details,
 * docs/onboarding.md). Checked on create and update; anything else is a 400.
 */
export const ORG_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;
export const OrgMetadata = z.strictObject({
  size: z.enum(ORG_SIZES).optional(),
  website: z
    .url({ protocol: /^https?$/ })
    .max(200)
    .optional(),
});
const checkMetadata = async ({ organization }: { organization: { metadata?: unknown } }) => {
  if (organization.metadata != null && !OrgMetadata.safeParse(organization.metadata).success) {
    throw new APIError('BAD_REQUEST', { message: 'invalid organization metadata' });
  }
};

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: allowedOrigins,
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  // The CRM person is synced once the email is verified (here, or below for SSO users the IdP
  // vouches for): an unverified sign-up must not claim a CRM person who has that email.
  // Disposable addresses (signup-guard.ts) are refused on every user write: email sign-up, SSO,
  // operator-created users and an email change. Invitations are checked in organizationHooks.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => assertAllowedEmail(user.email),
        after: async (user) => {
          if (user.emailVerified) await personSync(user.id);
        },
      },
      update: { before: async (user) => assertAllowedEmail(user.email) },
    },
  },
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
    afterEmailVerification: (user) => personSync(user.id),
    sendVerificationEmail: ({ user, url, token }, request) =>
      sendEmail('verify-email', user.email, url, token, request, { name: user.name }),
  },
  plugins: [
    organization({
      // Seats come from the plan (config/plans.json); checked on add-member and invite accept.
      membershipLimit: async (_user, org) => (await entitlements(org.id)).limits.seats,
      ...orgAccess,
      organizationHooks: {
        beforeCreateOrganization: checkMetadata,
        beforeUpdateOrganization: checkMetadata,
        beforeCreateInvitation: async ({ invitation }) => assertAllowedEmail(invitation.email),
        afterCreateOrganization: ({ organization, user }) =>
          crmSync({
            kind: 'org.created',
            eventId: `org:${organization.id}`,
            orgId: organization.id,
            userId: user.id,
          }),
      },
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
    apiKeys,
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
    // Operator console (docs/admin.md): role `operator` from OPERATOR_EMAILS, "view as user"
    // sessions (read-only via operatorGuard, time-boxed, never of another operator). Its HTTP
    // endpoints are closed (app.ts); /api/admin calls it server-side with a reason and audit.
    admin({
      ...operatorAccess,
      defaultRole: 'user',
      adminRoles: ['operator'],
      impersonationSessionDuration: env.OPERATOR_IMPERSONATION_MINUTES * 60,
      allowImpersonatingAdmins: false,
    }),
    operatorGuard(),
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
