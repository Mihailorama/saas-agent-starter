# 0033. Passwordless sign-in with email one-time codes

Status: accepted (owner decision, 2026-11-08). Changes ADR 0003 (no email/password) and ADR
0017 (second factor after a code sign-in).

## Context

Passwords are the weakest part of the auth stack (reuse, reset mails, hashing cost, breach
checks) and the owner wants none: an email address and a one-time code are enough. Passkeys and
SSO stay as the other ways in, TOTP as the second factor.

## Decision

- **Better Auth's `emailOTP` plugin** (`better-auth/plugins`, MIT, the same `better-auth`
  package): `POST /api/auth/email-otp/send-verification-otp` mails a 6-digit code,
  `POST /api/auth/sign-in/email-otp` signs in with it. The first sign-in for an address creates
  the account (sign-up by code), already verified, named after the address's local part until
  the user changes it. The organization onboarding is unchanged (create or accept an invitation
  after the first sign-in).
- **Codes**: 6 digits, 5 minutes, 3 wrong tries then the code is dead (`TOO_MANY_ATTEMPTS`), one
  use, stored encrypted with `BETTER_AUTH_SECRET` (`storeOTP: 'encrypted'`: a hash of a 6-digit
  code is no protection against a database reader). Asking again resends the same code with a
  new expiry (`resendStrategy: 'reuse'`) until its 3 tries are used, so nobody can replace a
  victim's pending code and guesses count against one code.
- **Failure cap**: wrong codes are counted per address (Redis, keyed by a SHA-256 of the
  address; `app.ts`). After 10 in an hour or 20 in a day no new code is mailed to that address
  until the window ends; the request still answers `{ success: true }` (no enumeration) and
  the API logs a warning with the hash only. The 3 tries of a code already sent still count.
- **Resend cooldown**: one code per address per 30 seconds, whoever asks (Redis key in
  `apps/api/src/app.ts`; `429`), on top of the 10/min per IP limit. A code sign-in that sets a
  session ends the cooldown (not a 2FA challenge), so signing out and in again needs no wait.
  Disposable addresses get no code and no mail (`assertAllowedEmail`, docs/security.md).
- **Mail**: our existing path (`renderEmail` EN/RU, `SendEmailWorkflow`, ADR 0014), kinds
  `sign-in-code` and `verify-email`. Only these two OTP types are mailed: the plugin's
  password-reset and change-email codes are never sent, and their endpoints answer 404. The code is never logged (pino redacts `*.otp`; Better Auth bodies are not logged).
- **Email verification** uses codes too (`overrideDefaultEmailVerification`): any Better Auth
  path that verifies an address mails a code for `/api/auth/email-otp/verify-email`. That
  endpoint only verifies, it does not sign in (`autoSignInAfterVerification` is off), so it can
  never skip the TOTP step. No current screen needs it: a code sign-in verifies the address.
- **Email + password is off** (`emailAndPassword: { enabled: false }`), and its UI, reset page,
  reset mail, `REQUIRE_EMAIL_VERIFICATION` and the operator's "resend verification" action are
  deleted: turning passwords back on would need all of them, so it is not a one-line switch.
  Migration `0014_drop_passwords` (a marked contract step) deletes every stored password hash,
  so accounts from before this change sign in by code and no 2FA change asks for a password
  they may have forgotten. Enrolling, disabling TOTP and new backup codes need a sign-in at most
  10 minutes old instead (mfa.ts re-auth; "Sign in again" on the security page).
- **TOTP after a code**: Better Auth 1.7.18's `twoFactor` plugin challenges only password,
  username and phone sign-ins. `auth.ts` runs the plugin's own after-hook on
  `/sign-in/email-otp` too, so an account with TOTP gets `{ twoFactorRedirect: true }` and no
  session, exactly like a password sign-in did. The org "require 2FA" policy, re-auth and the
  replay guard (mfa.ts) are unchanged.
- **Web**: two steps on `/sign-in` (email, then code) with shadcn's `input-otp` component (the
  `input-otp` package, MIT): paste, `autocomplete="one-time-code"`, auto-submit on the sixth
  digit, resend with the same 30 s countdown, plain-language errors.
- **Tests** get codes from Better Auth's server-only `createVerificationOTP` (not an HTTP route:
  nothing in production changes), through `apps/api/test/sign-in.ts`; the mailed path is tested
  through Mailpit in `api.test.ts` and every e2e spec. No test mode, no backdoor.

## Alternatives

- **Magic link**: one click, but the link must open in the browser that asked (or sign in a
  different one), mail scanners pre-fetch links, and it breaks on phones with separate mail
  apps. A code is typed anywhere.
- **Keep passwords next to codes**: two ways to maintain and test, reset mails, and the
  account is only as strong as the password. Not wanted.
- **Not flagged** (AGENTS.md "Feature flag rules"): the owner removes the password path, so
  there is no old path to keep working behind a flag.

## Limitations

- Mail delivery is now on the sign-in path: an SMTP outage blocks sign-in by code (passkeys and
  SSO still work). The worker retries delivery for up to an hour, longer than a code lives.
- Guessing: the failure cap allows at most 20 wrong codes per address a day (plus the up to 3
  tries of a code sent just before the cap), against 10^6 possible codes: about 0.002% a day,
  0.06% over a month of continuous trying. The mails the victim receives are a further signal.
- The cap is also a lockout lever: anyone who knows an address can stop code mails to it for up
  to a day by entering wrong codes. Passkeys and SSO still work; an operator can clear the
  address's `otp-fail-*` keys in Redis. Accepted for now: the alternative is unbounded guessing.
- A user cannot set a display name in the app yet (docs/TODO.md).
