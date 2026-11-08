import { env } from '../env.ts';

/**
 * Dub Partners (dub.co), the "connect" path for referrals (docs/growth.md): with DUB_API_KEY set,
 * referral links, leads and sales go to Dub, which runs the partner program and its payouts and
 * dual-sided coupons. Plain fetch against its REST API (no SDK). Read per call so tests can switch it.
 */
export function dub() {
  const key = env.DUB_API_KEY;
  if (!key) return null;
  const call = async (path: string, body: object) => {
    const res = await fetch(`${env.DUB_API_URL || 'https://api.dub.co'}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Dub ${path} answered ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  return {
    /** Enrols the org as a partner (idempotent per email) and returns its referral link. */
    async partnerLink(p: { orgId: string; name: string; email: string }) {
      const partner = await call('/partners', { email: p.email, name: p.name, tenantId: p.orgId });
      const links = partner.links as { shortLink?: string }[] | undefined;
      return links?.[0]?.shortLink ?? null;
    },
    /** The signup, attributed to the click Dub put in `?dub_id=`; the org is Dub's customer. */
    trackLead: (clickId: string, orgId: string) =>
      call('/track/lead', { clickId, eventName: 'Sign up', customerExternalId: orgId }),
    trackSale: (s: { orgId: string; amount: number; currency: string; invoiceId?: string }) =>
      call('/track/sale', {
        customerExternalId: s.orgId,
        amount: s.amount,
        currency: s.currency.toLowerCase(),
        eventName: 'Invoice paid',
        leadEventName: 'Sign up',
        paymentProcessor: 'stripe',
        invoiceId: s.invoiceId ?? null,
      }),
  };
}
