// Legal baseline (docs/legal.md): which terms and privacy versions a user must have accepted,
// the minimum age, and marketing mail with one-click unsubscribe (RFC 8058).
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { user } from '@app/db';
import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { type EmailKind, isMarketing, type Locale, renderEmail } from './email.ts';
import { env } from './env.ts';
import { startSendEmail } from './temporal.ts';

type Config = {
  documents: Record<'terms' | 'privacy', { version: string }>;
  age: { minimum: number; b2bOnly: boolean };
  sessionDays: number;
};
const config = JSON.parse(
  readFileSync(new URL('../../../config/legal.json', import.meta.url), 'utf8'),
) as Config;

/** What sign-up asks for (config/legal.json). */
export const LEGAL = {
  terms: config.documents.terms.version,
  privacy: config.documents.privacy.version,
  minAge: config.age.minimum,
  b2bOnly: config.age.b2bOnly,
  /** Session lifetime (auth.ts), also the session cookie's duration on the cookie policy. */
  sessionDays: config.sessionDays,
};

/** Error text when a user has not accepted the current terms and privacy versions. */
export const ACCEPTANCE_REQUIRED = 'legal acceptance required';

/** True when the user accepted the current terms and privacy versions. */
export const hasAccepted = (u: { termsVersion?: string | null; privacyVersion?: string | null }) =>
  u.termsVersion === LEGAL.terms && u.privacyVersion === LEGAL.privacy;

// Unsubscribe token: the user id and its HMAC under a key derived (HKDF) from BETTER_AUTH_SECRET,
// so the auth secret itself never signs these. No expiry and no table: a link in a year-old mail
// must still work, and it can only opt out. While rotating, the previous secret's key still verifies.
const keyOf = (secret: string) =>
  Buffer.from(hkdfSync('sha256', secret, '', 'unsubscribe-link-v1', 32));
const keys = () =>
  [env.BETTER_AUTH_SECRET, env.BETTER_AUTH_PREVIOUS_SECRET]
    .filter((s): s is string => Boolean(s))
    .map(keyOf);
const mac = (key: Buffer, userId: string) =>
  createHmac('sha256', key).update(userId).digest('base64url');
export const unsubscribeToken = (userId: string) => `${userId}.${mac(keys()[0]!, userId)}`;

/** The user id a token was issued for, or undefined when it is not ours. */
export function verifyUnsubscribe(token: string): string | undefined {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return undefined;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const ok = keys().some((k) => {
    const want = Buffer.from(mac(k, userId));
    return given.length === want.length && timingSafeEqual(given, want);
  });
  return ok ? userId : undefined;
}

export function unsubscribeLinks(userId: string) {
  const token = encodeURIComponent(unsubscribeToken(userId));
  return {
    page: `${env.BETTER_AUTH_URL}/unsubscribe?token=${token}`,
    oneClick: `${env.BETTER_AUTH_URL}/api/unsubscribe?token=${token}`,
  };
}

/**
 * Sends a marketing mail (a MARKETING_KINDS template) to a user who opted in and whose address is
 * verified, in their language; returns false and sends nothing otherwise. `campaign` makes the
 * send idempotent per user (Temporal workflow id). The worker checks the opt-in again right
 * before delivery, so an unsubscribe between here and a retried attempt still wins.
 */
export async function sendMarketingEmail(
  userId: string,
  kind: EmailKind,
  url: string,
  campaign: string,
): Promise<boolean> {
  if (!isMarketing(kind)) throw new Error(`${kind} is not a marketing kind`);
  const [u] = await db
    .select({
      email: user.email,
      name: user.name,
      optIn: user.marketingOptIn,
      verified: user.emailVerified,
      locale: user.locale,
    })
    .from(user)
    .where(eq(user.id, userId));
  if (!u?.optIn || !u.verified) return false;
  const locale: Locale = u.locale === 'ru' ? 'ru' : 'en';
  const mail = await renderEmail(kind, locale, url, { name: u.name }, unsubscribeLinks(userId));
  await startSendEmail({ kind, to: u.email, ...mail, userId }, `${campaign}:${userId}`);
  return true;
}
