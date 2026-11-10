// Legal baseline (docs/legal.md): which terms and privacy versions a user must have accepted,
// the minimum age, and marketing mail with one-click unsubscribe (RFC 8058).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { user } from '@app/db';
import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { type EmailKind, isMarketing, renderEmail } from './email.ts';
import { env } from './env.ts';
import { startSendEmail } from './temporal.ts';

type Config = {
  documents: Record<'terms' | 'privacy', { version: string }>;
  age: { minimum: number; b2bOnly: boolean };
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
};

/** Error text when a user has not accepted the current terms and privacy versions. */
export const ACCEPTANCE_REQUIRED = 'legal acceptance required';

/** True when the user accepted the current terms and privacy versions. */
export const hasAccepted = (u: { termsVersion?: string | null; privacyVersion?: string | null }) =>
  u.termsVersion === LEGAL.terms && u.privacyVersion === LEGAL.privacy;

// Unsubscribe token: the user id and its HMAC under a key derived from BETTER_AUTH_SECRET. No
// expiry and no table: a link in a year-old mail must still work, and it can only opt out.
const mac = (userId: string) =>
  createHmac('sha256', env.BETTER_AUTH_SECRET).update(`unsubscribe:${userId}`).digest('base64url');
export const unsubscribeToken = (userId: string) => `${userId}.${mac(userId)}`;

/** The user id a token was issued for, or undefined when it is not ours. */
export function verifyUnsubscribe(token: string): string | undefined {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return undefined;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(userId));
  return given.length === want.length && timingSafeEqual(given, want) ? userId : undefined;
}

export function unsubscribeLinks(userId: string) {
  const token = encodeURIComponent(unsubscribeToken(userId));
  return {
    page: `${env.BETTER_AUTH_URL}/unsubscribe?token=${token}`,
    oneClick: `${env.BETTER_AUTH_URL}/api/unsubscribe?token=${token}`,
  };
}

/**
 * Sends a marketing mail (a MARKETING_KINDS template) to a user who opted in; returns false and
 * sends nothing otherwise. `campaign` makes the send idempotent per user (Temporal workflow id).
 */
export async function sendMarketingEmail(
  userId: string,
  kind: EmailKind,
  url: string,
  campaign: string,
): Promise<boolean> {
  if (!isMarketing(kind)) throw new Error(`${kind} is not a marketing kind`);
  const [u] = await db
    .select({ email: user.email, name: user.name, optIn: user.marketingOptIn })
    .from(user)
    .where(eq(user.id, userId));
  if (!u?.optIn) return false;
  const mail = await renderEmail(kind, 'en', url, { name: u.name }, unsubscribeLinks(userId));
  await startSendEmail({ kind, to: u.email, ...mail }, `${campaign}:${userId}`);
  return true;
}
