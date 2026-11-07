import { env } from '../env.ts';
import { contour, plans } from './plans.ts';
import { type BillingProvider, ProviderNotConfigured } from './provider.ts';
import { stripeProvider } from './stripe.ts';

const cache = new Map<string, BillingProvider>();

/** The provider of a billing contour (config/plans.json), configured from env. */
export function providerFor(contourId: string): BillingProvider {
  const cached = cache.get(contourId);
  if (cached) return cached;
  const id = contour(contourId).provider;
  let p: BillingProvider;
  if (id === 'stripe') {
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
  cache.set(contourId, p);
  return p;
}

/** Contour whose provider has this id (webhook URLs name the provider, not the contour). */
export const contourOfProvider = (providerId: string) =>
  Object.entries(plans.contours).find(([, c]) => c.provider === providerId)?.[0];
