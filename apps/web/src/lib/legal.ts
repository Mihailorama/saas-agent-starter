// Legal pages and acceptance (docs/legal.md). The pages live on the public site (apps/site,
// generated from config/legal.json); the API decides whether a user must accept (GET /api/legal).

import { client, ok } from '@/lib/api';
import config from '../../../../config/legal.json';

/** The public site the legal pages are on (its SITE_URL); the site's dev server by default. */
const siteUrl = (
  (import.meta.env.VITE_SITE_URL as string | undefined) || 'http://localhost:4321'
).replace(/\/+$/, '');

const ids = ['privacy', 'terms', 'refunds', 'cookies', 'imprint'] as const;
export type LegalDoc = (typeof ids)[number];
export const legalUrl = (id: LegalDoc) => `${siteUrl}/legal/${id}/`;
export const legalLinks = ids.map((id) => ({
  id,
  title: config.documents[id].title,
  href: legalUrl(id),
}));
/** Shown next to prices on the billing page. */
export const taxNote = config.billing.taxNote;

/** Whether the signed-in user must accept (again); keyed by user so a sign-out never leaks it. */
export const legalQuery = (userId: string | undefined) =>
  ({
    queryKey: ['legal', userId],
    queryFn: () => ok(client.GET('/api/legal/')),
    staleTime: 60_000,
  }) as const;
