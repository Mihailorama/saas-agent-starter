// Sign-up protection (docs/security.md): no account or invitation for a disposable address.
// The list is mailchecker's (MIT, bundled, updated with the package by Dependabot); no downloads.
import { APIError } from 'better-auth/api';
import { isValid } from 'mailchecker';
import { env } from './env.ts';

export const DISPOSABLE_EMAIL = 'This email address cannot be used. Please use another one.';

/** The domain or one of its parents is in the list (sub.example.com matches example.com). */
const listed = (domain: string, list: string[]) =>
  list.some((d) => domain === d || domain.endsWith(`.${d}`));

/** True when the address must be refused. Case-insensitive; the local part is never looked at. */
export function isBlockedEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@').at(-1) ?? '';
  if (listed(domain, env.SIGNUP_EMAIL_DENY_DOMAINS)) return true;
  if (!env.SIGNUP_BLOCK_DISPOSABLE || listed(domain, env.SIGNUP_EMAIL_ALLOW_DOMAINS)) return false;
  return !isValid(`x@${domain}`); // mailchecker walks parent domains too
}

/** Throws the neutral 400 every entry point returns (sign-up, SSO, email change, invitation). */
export function assertAllowedEmail(email: string | undefined) {
  if (email && isBlockedEmail(email)) {
    throw new APIError('BAD_REQUEST', { message: DISPOSABLE_EMAIL, code: 'EMAIL_NOT_ALLOWED' });
  }
}
