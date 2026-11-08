import { env } from '../env.ts';
import { manualProvider } from './manual.ts';
import { contour, plans } from './plans.ts';
import { type BillingProvider, ProviderNotConfigured } from './provider.ts';
import { stripeProvider } from './stripe.ts';

const cache = new Map<string, BillingProvider>();

/**
 * The provider of a billing contour (config/plans.json), configured from env. `id` overrides it
 * for a subscription on another provider of the contour (a `manual` contract, say).
 */
export function providerFor(contourId: string, id = contour(contourId).provider): BillingProvider {
  const key = `${contourId}:${id}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let p: BillingProvider;
  if (id === 'manual') {
    p = manualProvider;
  } else if (id === 'stripe') {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) throw new ProviderNotConfigured(id);
    p = stripeProvider({
      contour: contourId,
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      apiUrl: env.STRIPE_API_URL,
    });
  } else {
    // Another provider: add its adapter and env here (docs/billing.md "Adding a provider").
    throw new ProviderNotConfigured(id);
  }
  cache.set(key, p);
  return p;
}

/** Contour whose provider has this id (webhook URLs name the provider, not the contour). */
export const contourOfProvider = (providerId: string) =>
  Object.entries(plans.contours).find(([, c]) => c.provider === providerId)?.[0];

/** The provider of an existing subscription. */
export const providerOf = (sub: { contour: string; provider: string }) =>
  providerFor(sub.contour, sub.provider);
