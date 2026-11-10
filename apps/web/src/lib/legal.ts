// Legal pages and acceptance (docs/legal.md). The pages live on the public site (apps/site,
// generated from config/legal.json); the API decides whether a user must accept (GET /api/legal).

import { client, ok } from '@/lib/api';
import { billing, documents } from '../../../../config/legal.json';

/** The public site the legal pages are on (its SITE_URL); the site's dev server by default. */
const siteUrl = (
  (import.meta.env.VITE_SITE_URL as string | undefined) || 'http://localhost:4321'
).replace(/\/+$/, '');

const ids = ['privacy', 'terms', 'refunds', 'cookies', 'imprint'] as const;
export type LegalDoc = (typeof ids)[number];
export const legalUrl = (id: LegalDoc) => `${siteUrl}/legal/${id}/`;
export const legalLinks = ids.map((id) => ({
  id,
  title: documents[id].title,
  href: legalUrl(id),
}));
/** Shown next to prices on the billing page. */
export const taxNote = billing.taxNote;

export const ACCEPT_TERMS_PATH = '/accept-terms';
export const PRIVACY_PATH = '/settings/privacy';
/** The API's answer while the current terms are not accepted (tenant routes and org endpoints). */
const NOT_ACCEPTED = new Set(['legal acceptance required', 'LEGAL_ACCEPTANCE_REQUIRED']);

/**
 * A 403 because the terms changed since this tab checked: send the user to accept them, then
 * back. Returns true when it redirected (apps/web/src/lib/api.ts calls it on every 403).
 */
export async function redirectIfNotAccepted(response: Response): Promise<boolean> {
  // Not from the acceptance step, nor from Settings, Privacy (open to those who decline).
  if (
    response.status !== 403 ||
    [ACCEPT_TERMS_PATH, PRIVACY_PATH].includes(window.location.pathname)
  )
    return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { error?: string; code?: string };
  if (!NOT_ACCEPTED.has(body.error ?? '') && !NOT_ACCEPTED.has(body.code ?? '')) return false;
  const back = window.location.pathname + window.location.search;
  window.location.assign(`${ACCEPT_TERMS_PATH}?redirect=${encodeURIComponent(back)}`);
  return true;
}

/** Whether the signed-in user must accept (again); keyed by user so a sign-out never leaks it. */
export const legalQuery = (userId: string | undefined) =>
  ({
    queryKey: ['legal', userId],
    queryFn: () => ok(client.GET('/api/legal/')),
    staleTime: 60_000,
  }) as const;
