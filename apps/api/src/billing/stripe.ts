import Stripe from 'stripe';
import { toMinor } from './money.ts';
import { componentByProviderPriceId, type PriceComponent } from './plans.ts';
import { type BillingEvent, type BillingProvider, WebhookRejected } from './provider.ts';

/** Checkout/subscription items: metered prices take no quantity, per-seat prices the seats. */
export function lineItems(prices: PriceComponent[], seats: number) {
  return prices.map((c) => {
    if (!c.providerPriceId) throw new Error(`no Stripe price id for a ${c.model} price`);
    if (c.model === 'metered') return { price: c.providerPriceId };
    return { price: c.providerPriceId, quantity: c.model === 'per_seat' ? Math.max(1, seats) : 1 };
  });
}

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
    const known = sub.items.data.map((i) => ({ i, ...componentByProviderPriceId(i.price.id) }));
    const seats = known.find((k) => k.component?.model === 'per_seat')?.i.quantity;
    const state = {
      ...base(e, orgId),
      planId: known.find((k) => k.planId)?.planId ?? sub.metadata.planId,
      ...(seats !== undefined && { seats }),
      ...(sub.metadata.contractRef && { contractRef: sub.metadata.contractRef }),
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

    invoicing: 'provider',

    async checkout(input) {
      const metadata = { orgId: input.orgId, planId: input.planId };
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: lineItems(input.prices, input.seats),
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

    // A credit pack: a one-time payment; the worker grants it after checkout.session.completed.
    async topUp(input) {
      if (!input.pack.providerPriceId) throw new Error('no Stripe price id for the credit pack');
      const metadata = { orgId: input.orgId, planId: input.planId, kind: 'credits' };
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: input.customerId,
        line_items: [{ price: input.pack.providerPriceId, quantity: 1 }],
        metadata,
        payment_intent_data: { metadata },
        success_url: `${input.returnUrl}?checkout=success`,
        cancel_url: `${input.returnUrl}?checkout=canceled`,
      });
      if (!session.url) throw new Error('Stripe returned a checkout session without url');
      return { url: session.url };
    },

    async creditBalance(sub) {
      if (!sub.customerId) return 0;
      const summary = await stripe.billing.creditBalanceSummaries.retrieve({
        customer: sub.customerId,
        filter: { type: 'applicability_scope', applicability_scope: { price_type: 'metered' } },
      });
      return summary.balances
        .map((b) => b.available_balance.monetary)
        .filter((m) => m?.currency.toUpperCase() === sub.currency)
        .reduce((sum, m) => sum + (m?.value ?? 0), 0);
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

    // Rewards (docs/growth.md). The balance pays the next invoices (flat, per-seat and metered
    // alike); a coupon joins the subscription's discounts. Each call carries an idempotency key.

    async applyCredit(sub, c) {
      if (!sub.customerId) throw new Error('no Stripe customer');
      const txn = await stripe.customers.createBalanceTransaction(
        sub.customerId,
        {
          amount: -toMinor(c.amount, c.currency), // negative = a credit
          currency: c.currency.toLowerCase(),
          description: c.description,
        },
        { idempotencyKey: c.key },
      );
      return txn.id;
    },

    async applyCoupon(sub, c) {
      if (!sub.providerSubscriptionId) throw new Error('no Stripe subscription');
      const current = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
      const keep = current.discounts.map((d) => ({ discount: typeof d === 'string' ? d : d.id }));
      const s = await stripe.subscriptions.update(
        sub.providerSubscriptionId,
        { discounts: [...keep, { coupon: c.couponId }] },
        { idempotencyKey: c.key },
      );
      return s.id;
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
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          const session = e.data.object;
          const orgId = session.metadata?.orgId;
          if (session.metadata?.kind !== 'credits' || !orgId || session.payment_status !== 'paid') {
            return [];
          }
          // The grant is the plan's pack value (the worker reads it), never amount_total, which
          // includes tax and discounts.
          return [
            {
              ...base(e, orgId),
              eventId: session.id, // one grant per paid session, whichever event reports it
              type: 'credits.purchased',
              planId: session.metadata.planId,
              currency: session.currency?.toUpperCase(),
              customerId: typeof session.customer === 'string' ? session.customer : undefined,
            },
          ];
        }
        case 'invoice.paid':
        case 'invoice.payment_failed': {
          const orgId = e.data.object.parent?.subscription_details?.metadata?.orgId;
          if (!orgId) return [];
          const type = e.type === 'invoice.paid' ? 'payment.succeeded' : 'payment.failed';
          return [{ ...base(e, orgId), type }];
        }
        default:
          return [];
      }
    },
  };
}
