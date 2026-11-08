import Stripe from 'stripe';
import { planByProviderPriceId } from './plans.ts';
import { type BillingEvent, type BillingProvider, WebhookRejected } from './provider.ts';

/**
 * Stripe adapter (official `stripe` SDK, MIT). Stripe owns the subscription: Checkout creates it,
 * Stripe renews it and tells us through webhooks. `apiUrl` points the SDK at stripe-mock in tests.
 */
export function stripeProvider(opts: {
  contour: string;
  secretKey: string;
  webhookSecret: string;
  apiUrl?: string;
}): BillingProvider {
  const url = opts.apiUrl ? new URL(opts.apiUrl) : undefined;
  const stripe = new Stripe(
    opts.secretKey,
    url
      ? {
          host: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          protocol: url.protocol === 'http:' ? 'http' : 'https',
          maxNetworkRetries: 0,
        }
      : { maxNetworkRetries: 2 },
  );
  const base = (e: Stripe.Event, orgId: string) => ({
    provider: 'stripe',
    contour: opts.contour,
    eventId: e.id,
    orgId,
    occurredAt: new Date(e.created * 1000).toISOString(),
  });

  function subscriptionEvent(e: Stripe.Event, sub: Stripe.Subscription): BillingEvent[] {
    const orgId = sub.metadata?.orgId;
    const item = sub.items.data[0];
    if (!orgId || !item) return []; // not created by our checkout
    const state = {
      ...base(e, orgId),
      planId: planByProviderPriceId(item.price.id) ?? sub.metadata.planId,
      currency: sub.currency.toUpperCase(),
      customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
      subscriptionId: sub.id,
      periodStart: new Date(item.current_period_start * 1000).toISOString(),
      periodEnd: new Date(item.current_period_end * 1000).toISOString(),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
    if (e.type === 'customer.subscription.deleted' || sub.status === 'canceled') {
      return [{ ...state, type: 'subscription.canceled' }];
    }
    if (sub.status === 'past_due' || sub.status === 'unpaid') {
      return [{ ...state, type: 'subscription.past_due' }];
    }
    if (sub.status !== 'active' && sub.status !== 'trialing') return []; // incomplete, paused
    const prev = (
      e.data as { previous_attributes?: { items?: Stripe.ApiList<Stripe.SubscriptionItem> } }
    ).previous_attributes;
    const prevEnd = prev?.items?.data?.[0]?.current_period_end;
    const renewed = prevEnd !== undefined && prevEnd < item.current_period_end;
    return [{ ...state, type: renewed ? 'subscription.renewed' : 'subscription.activated' }];
  }

  return {
    id: 'stripe',

    async checkout(input) {
      if (!input.price.providerPriceId) throw new Error(`no Stripe price id for ${input.planId}`);
      const metadata = {
        orgId: input.orgId,
        planId: input.planId,
        ...(input.referral && { referrerOrgId: input.referral.referrerOrgId }),
      };
      // The referrer's promotion code: Stripe applies it only to a first-time customer.
      const promo = input.referral
        ? (await stripe.promotionCodes.list({ code: input.referral.promotionCode, limit: 1 }))
            .data[0]
        : undefined;
      const session = await stripe.checkout.sessions.create({
        ...(promo && { discounts: [{ promotion_code: promo.id }] }),
        mode: 'subscription',
        line_items: [{ price: input.price.providerPriceId, quantity: 1 }],
        client_reference_id: input.orgId,
        ...(input.customerId && { customer: input.customerId }),
        metadata,
        subscription_data: { metadata },
        success_url: `${input.returnUrl}?checkout=success`,
        cancel_url: `${input.returnUrl}?checkout=canceled`,
      });
      if (!session.url) throw new Error('Stripe returned a checkout session without url');
      return { url: session.url };
    },

    async portal(sub, returnUrl) {
      if (!sub.customerId) return null;
      const session = await stripe.billingPortal.sessions.create({
        customer: sub.customerId,
        return_url: returnUrl,
      });
      return session.url;
    },

    async cancel(sub) {
      if (!sub.providerSubscriptionId) return;
      await stripe.subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: true });
    },

    // Test-mode keys (sk_test_...) see their objects under /test in the dashboard.
    dashboardUrl(sub) {
      const base = `https://dashboard.stripe.com${opts.secretKey.startsWith('sk_test_') ? '/test' : ''}`;
      if (sub.providerSubscriptionId) return `${base}/subscriptions/${sub.providerSubscriptionId}`;
      return sub.customerId ? `${base}/customers/${sub.customerId}` : null;
    },

    // Rewards (docs/growth.md). Credit grants reach only metered prices, the balance the next
    // invoice, a coupon the subscription. Each call carries an idempotency key.
    capabilities: () => ({
      invoicing: 'provider',
      balanceCredit: true,
      creditGrants: true,
      coupons: true,
    }),

    async usageBased(sub) {
      if (!sub.providerSubscriptionId) return false;
      const s = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
      return s.items.data.some((i) => i.price.recurring?.usage_type === 'metered');
    },

    async applyCredit(sub, c) {
      if (!sub.customerId) throw new Error('no Stripe customer');
      // ponytail: two-decimal currencies only; zero-decimal ones (JPY) need their own minor unit.
      const value = Number(c.amount.replace('.', ''));
      const currency = c.currency.toLowerCase();
      const idempotent = { idempotencyKey: c.key };
      if (c.via === 'credit_grant') {
        const grant = await stripe.billing.creditGrants.create(
          {
            customer: sub.customerId,
            amount: { type: 'monetary', monetary: { value, currency } },
            applicability_config: { scope: { price_type: 'metered' } },
            category: 'promotional',
            name: c.description,
          },
          idempotent,
        );
        return grant.id;
      }
      // A negative balance transaction is a credit, used by the customer's next invoices.
      const txn = await stripe.customers.createBalanceTransaction(
        sub.customerId,
        { amount: -value, currency, description: c.description },
        idempotent,
      );
      return txn.id;
    },

    async applyCoupon(sub, c) {
      if (!sub.providerSubscriptionId) throw new Error('no Stripe subscription');
      // ponytail: replaces the subscription's discounts; merge them if you stack promotions.
      const s = await stripe.subscriptions.update(
        sub.providerSubscriptionId,
        { discounts: [{ coupon: c.couponId }] },
        { idempotencyKey: c.key },
      );
      return s.id;
    },

    async createPromotionCode(p) {
      const promo = await stripe.promotionCodes.create(
        {
          promotion: { type: 'coupon', coupon: p.couponId },
          code: p.code,
          restrictions: { first_time_transaction: true },
          metadata: { referrerOrgId: p.referrerOrgId },
        },
        { idempotencyKey: p.key },
      );
      return promo.id;
    },

    async webhook(req) {
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string') throw new WebhookRejected('missing signature');
      let e: Stripe.Event;
      try {
        e = await stripe.webhooks.constructEventAsync(req.body, signature, opts.webhookSecret);
      } catch {
        throw new WebhookRejected('bad signature');
      }
      switch (e.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          return subscriptionEvent(e, e.data.object);
        case 'invoice.paid':
        case 'invoice.payment_failed': {
          const invoice = e.data.object;
          const meta = invoice.parent?.subscription_details?.metadata;
          const orgId = meta?.orgId;
          if (!orgId) return [];
          if (e.type === 'invoice.payment_failed')
            return [{ ...base(e, orgId), type: 'payment.failed' }];
          const paid = {
            ...base(e, orgId),
            amount: invoice.amount_paid,
            currency: invoice.currency.toUpperCase(),
            ...(invoice.id && { invoiceId: invoice.id }),
          };
          // A referral converts on a paid (non-zero) invoice; the reward counts it once per org.
          const referrerOrgId = meta?.referrerOrgId;
          return [
            { ...paid, type: 'payment.succeeded' },
            ...(referrerOrgId && invoice.amount_paid > 0
              ? [
                  {
                    ...paid,
                    eventId: `${e.id}:referral`,
                    type: 'referral.converted' as const,
                    referrerOrgId,
                  },
                ]
              : []),
          ];
        }
        default:
          return [];
      }
    },
  };
}
