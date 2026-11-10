// Better Auth tables (core + organization plugin). Regenerate after changing
// auth plugins: `pnpm dlx @better-auth/cli generate` and reconcile here.
// Not tenant-scoped by RLS: Better Auth reads them across orgs by user id.
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at').notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** twoFactor plugin: true once TOTP enrolment is verified. */
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  /** admin plugin: `operator` for the back office (OPERATOR_EMAILS, docs/admin.md), else `user`. */
  role: text('role'),
  /** admin plugin's user ban; unused by the console (it suspends organizations instead). */
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  /** Organization whose invitation reward this account counted for, once ever (docs/growth.md). */
  inviteRewardOrgId: text('invite_reward_org_id'),
  /** Referral the user signed up with (docs/growth.md): an org's referral code, or Dub's click id
   * with DUB_API_KEY. Read once when they create an organization. */
  referralCode: text('referral_code'),
  /** Legal acceptance (docs/legal.md): the terms and privacy versions of config/legal.json the
   * user accepted, and when. Null until the first acceptance; the API asks again on a new version. */
  termsVersion: text('terms_version'),
  privacyVersion: text('privacy_version'),
  legalAcceptedAt: timestamp('legal_accepted_at'),
  /** When the user confirmed the minimum age of config/legal.json (null when not asked: B2B-only). */
  ageConfirmedAt: timestamp('age_confirmed_at'),
  /** Opt-in to non-transactional (marketing) email, and when it last changed. Account mail is
   * unaffected. The unsubscribe link and List-Unsubscribe header set it to false. */
  marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
  marketingOptInAt: timestamp('marketing_opt_in_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  activeOrganizationId: text('active_organization_id'),
  /** admin plugin: the operator viewing as this user (read-only, time-boxed; docs/admin.md). */
  impersonatedBy: text('impersonated_by'),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at').notNull(),
  metadata: text('metadata'),
  /** Org policy, set by admins (routes/security.ts): members need 2FA to reach tenant data. */
  requireTwoFactor: boolean('require_two_factor').notNull().default(false),
  /** Set by an operator (docs/admin.md): members and API keys get 403 ORG_SUSPENDED. */
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  /** Internal note for operators; never shown to the organization. */
  suspendReason: text('suspend_reason'),
  /** Operator overrides of plan limits, capped by the plan's `limitsMax` (config/plans.json). */
  limitOverrides: jsonb('limit_overrides').$type<{ seats?: number; projects?: number }>(),
  /** This org's own referral code (`?ref=`), created with its first referral link. */
  referralCode: text('referral_code').unique(),
  /** Dub Partners' link for this org, created once (DUB_API_KEY, docs/growth.md). */
  referralLink: text('referral_link'),
  /** Org that referred this one (docs/growth.md), or `dub` when Dub Partners attributed it. */
  referredBy: text('referred_by'),
});

export const member = pgTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at').notNull(),
});

export const invitation = pgTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: createdAt(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

// @better-auth/api-key, organization-owned keys (`references: 'organization'`): referenceId is
// the organization id. Only the SHA-256 of the key is stored; `start` is its visible prefix.
export const apikey = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    prefix: text('prefix'),
    key: text('key').notNull().unique(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at'),
    enabled: boolean('enabled').notNull().default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').notNull().default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').notNull().default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [index().on(t.referenceId)],
);

// twoFactor plugin (better-auth/plugins): TOTP secret and backup codes, both encrypted.
export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until'),
    /** Ours, not the plugin's: last accepted TOTP time step, so a code works once (mfa.ts). */
    lastTotpStep: integer('last_totp_step'),
  },
  (t) => [index().on(t.secret), index().on(t.userId)],
);

// Passkey plugin (@better-auth/passkey): WebAuthn credentials (public keys only).
export const passkey = pgTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: timestamp('created_at'),
    aaguid: text('aaguid'),
  },
  (t) => [index().on(t.userId), index().on(t.credentialID)],
);
