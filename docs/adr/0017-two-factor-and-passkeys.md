# 0017. Two-factor authentication and passkeys

Status: accepted (owner decision, 2026-11-07)

## Context

B2B customers ask for a second factor, often as an organization-wide rule, and for passwordless
sign-in. Auth is Better Auth inside the API (ADR 0003), so both should come from its plugins on
our own tables, not from another service.

## Decision

- **TOTP** with Better Auth's `twoFactor` plugin (`better-auth/plugins`, MIT): enrolment with a QR
  code (rendered locally by `qrcode.react`, ISC; the URI holds the secret, so never an external QR
  service), 10 one-time backup codes, "trust this device" for 30 days (signed cookie + server-side
  record), a 10-minute sign-in challenge, account lockout after 10 failed codes. Secrets and
  backup codes are stored encrypted with `BETTER_AUTH_SECRET`. Email/SMS OTP is not configured.
- **Passkeys** with `@better-auth/passkey` (MIT; WebAuthn via `@simplewebauthn/server` and
  `@simplewebauthn/browser`, MIT): register, list, rename, delete in account settings and sign in
  with a discoverable credential. A passkey sign-in counts as multi-factor (device + PIN or
  biometric) and skips the TOTP step. Relying party: `PASSKEY_RP_ID` / `PASSKEY_ORIGIN`, defaulting
  to the host and origin of `BETTER_AUTH_URL`; `APP_NAME` names the app in authenticator apps and
  passkey prompts.
- **Org policy "require 2FA for all members"**: `organization.require_two_factor`, set by admins
  through `PUT /api/security/policy` (audited like every tenant mutation). An admin can turn it on
  only with 2FA on their own account. `requireRole` (`apps/api/src/tenant.ts`) answers
  `403 two-factor authentication required` to members without TOTP; the web sends them to
  Settings -> Security to enrol. Compliance means TOTP enabled: a passkey alone does not count,
  because the same account could still sign in with the password only.
- **Sensitive changes need a recent sign-in** ("sudo mode", `apps/api/src/mfa.ts`): disabling
  2FA, regenerating backup codes and deleting a passkey are refused with `SESSION_NOT_FRESH`
  when the session is older than 10 minutes; the password is asked as well where the account
  has one. Registering a passkey needs a session younger than Better Auth's `freshAge` (1 day).
  The web offers "Sign in again" and returns to the security page.
- **Audit**: 2FA enabled/disabled, backup codes regenerated, passkey added/renamed/deleted go to
  `audit_log` (actions `two_factor.*`, `passkey.*`), one row per organization the user belongs
  to, written after Better Auth commits the change. The client IP comes from Fastify's
  `req.ip` (TRUST_PROXY-aware), passed to Better Auth as `x-forwarded-for`.
- Rate limits: `/api/auth/two-factor/*` and passkey sign-in get the sign-in limit
  (10/min per IP, Redis-backed).

## Alternatives

- `otplib`/`speakeasy` plus own tables: more code to own for what the plugin already does with
  lockout, trusted devices and encrypted storage.
- Keycloak or a hosted IdP for MFA: see ADR 0003; SSO users can rely on their IdP's MFA, and may
  also enrol TOTP here (`allowPasswordless`).

## Limitations

- Better Auth's own organization endpoints (`/api/auth/organization/*`: invite, roles) are not
  gated by the org 2FA policy; only our tenant routes are (docs/TODO.md).
- Better Auth does not reject a TOTP code that was already used inside its validity window
  (checked with 1.7.17: the enrolment code also passes the next sign-in). Lockout and the
  per-IP limit bound guessing; replay of an observed code within ~30-60 s remains possible.
- The passkey flow is tested end to end only with Chrome's virtual authenticator (CDP); real
  platform authenticators (Touch ID, Windows Hello, security keys) are checked by hand.
