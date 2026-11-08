# Security

## Sign-up protection

Registration refuses temporary / disposable email addresses (temp-mail, mailinator and the
like), so they cannot be used to spam the system with throwaway accounts.

**What is checked.** Every place an address enters, with one rule (`apps/api/src/signup-guard.ts`):

| Entry point                                  | Where it is enforced                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| Email + password sign-up                     | Better Auth `databaseHooks.user.create.before`          |
| SSO (OIDC) first login                       | same hook: the IdP's address is checked too             |
| Users created by an operator (admin plugin)  | same hook                                               |
| Email change (off in this app; if turned on) | `databaseHooks.user.update.before` when `email` changes |
| Organization invitations (invited address)   | `organizationHooks.beforeCreateInvitation`              |

Magic link and email OTP are not enabled; if added, their users are created through the same
hook. The answer is a `400` with code `EMAIL_NOT_ALLOWED` and a neutral message ("This email
address cannot be used. Please use another one."), never the list or the matched domain. The
sign-up form shows that message.

**SSO choice: reject.** An IdP vouches that the mailbox works, and a temporary mailbox works
too: an IdP with open self-registration would otherwise be a way around the check. An operator
who trusts its IdP completely adds that domain to the allow-list.

**Normalization.** The domain is compared case-insensitively, and a listed domain also covers
its subdomains (`a@x.mailinator.com` is refused). The local part is not touched: no
plus-addressing or dot rules, because mailchecker does not define any and we do not invent them.

**The list.** [`mailchecker`](https://github.com/FGRibreau/mailchecker) (MIT, about 56,000
domains, bundled in the npm package, released every few months). It
updates with the dependency (Dependabot's weekly npm group); nothing is downloaded at runtime.
Why not the alternatives: `better-auth-harmony` (MIT) uses the same mailchecker list but adds a
`normalizedEmail` column (a migration), pulls `validator` and `libphonenumber-js`, and does not
cover invitations; the `disposable-email-domains` list (CC0-1.0, accepted by the gate) reaches
npm only through third-party repackagings, so it would add a second maintainer to trust.

**Configuration** (API env, a plain setting and not a feature flag: it is protection, not new
user-visible behaviour):

| Variable                     | Default | Meaning                                                            |
| ---------------------------- | ------- | ------------------------------------------------------------------ |
| `SIGNUP_BLOCK_DISPOSABLE`    | `true`  | Refuse domains on mailchecker's list                               |
| `SIGNUP_EMAIL_ALLOW_DOMAINS` | empty   | Comma-separated domains (and subdomains) accepted despite the list |
| `SIGNUP_EMAIL_DENY_DOMAINS`  | empty   | Comma-separated domains always refused, even with the list off     |

Existing accounts are not touched: the check runs when an address is written, not on sign-in.

**Bot checks (not included).** Better Auth's built-in `captcha` plugin supports Cloudflare
Turnstile, Google reCAPTCHA, hCaptcha, CaptchaFox and Vercel BotID; it has no ALTCHA or other
self-hosted proof-of-work provider. Wiring it needs a widget on the sign-up form and CSP
changes, so it is a follow-up (docs/TODO.md).
