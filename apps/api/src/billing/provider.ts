import type { Subscription } from './entitlements.ts';
import type { PriceComponent } from './plans.ts';

/**
 * A payment provider, normalized (docs/billing.md "Adding a provider"). Nothing here is
 * provider-specific: an adapter maps its own objects to these shapes. What a provider can do is
 * which optional methods it has; routes and the billing page check for them.
 */
export interface BillingProvider {
  readonly id: string;
  /** Who sends invoices: the provider, or someone outside it (`manual` contracts). Rewards for
   * `external` orgs wait for operators (docs/growth.md). */
  readonly invoicing: 'provider' | 'external';
  /** Hosted payment page for the first period of `planId`; returns where to send the browser. */
  checkout?(input: CheckoutInput): Promise<{ url: string }>;
  /** Optional: hosted payment page for one prepaid credit pack (docs/billing.md). */
  topUp?(input: TopUpInput): Promise<{ url: string }>;
  /** Optional: the provider's prepaid balance left, in minor units of the currency. */
  creditBalance?(sub: Subscription): Promise<number>;
  /** Hosted self-service page (invoices, payment method), or null for this subscription. */
  portal?(sub: Subscription, returnUrl: string): Promise<string | null>;
  /** Stop renewing at the end of the paid period. */
  cancel?(sub: Subscription): Promise<void>;
  /** Verifies a webhook and maps it to events; throws WebhookRejected if it is not authentic. */
  webhook(req: WebhookRequest): Promise<BillingEvent[]>;
  /** The subscription in the provider's own dashboard, for operators (docs/admin.md). */
  dashboardUrl(sub: Subscription): string | null;
  /** Optional (rewards, docs/growth.md): credits money to the customer's balance, used by its
   * next invoices (metered ones too); returns the provider object's id. */
  applyCredit?(sub: Subscription, credit: Credit): Promise<string>;
  /** Optional (rewards): adds a coupon to the subscription, keeping its other discounts. */
  applyCoupon?(sub: Subscription, coupon: { couponId: string; key: string }): Promise<string>;
  /** Referrals' fraud signal: fingerprints of the customer's saved cards (same card = same payer). */
  cardFingerprints?(customerId: string): Promise<string[]>;
  /** Referrals: a promotion code for `couponId`, valid on first payments only; returns its id. */
  createPromotionCode?(p: {
    code: string;
    couponId: string;
    referrerOrgId: string;
    key: string;
  }): Promise<string>;
}

export type Credit = {
  /** Decimal string in major units ("5.00"; money.ts converts), in `currency` (the customer's). */
  amount: string;
  currency: string;
  description: string;
  /** Idempotency key: the same key never credits twice (also across retries). */
  key: string;
};

export type CheckoutInput = {
  orgId: string;
  planId: string;
  planName: string;
  currency: string;
  /** The plan's components in `currency` to subscribe to (flat, per_seat, metered). */
  prices: PriceComponent[];
  /** Quantity for a per_seat component: the org's current members. */
  seats: number;
  /** Provider customer id from an earlier subscription, if any. */
  customerId: string | null;
  /** Page the provider sends the user back to (`?checkout=success|canceled` is appended). */
  returnUrl: string;
  /** Referred org (docs/growth.md): the referrer's promotion code, echoed back on payments. */
  referral?: { promotionCode: string; referrerOrgId: string };
};

export type TopUpInput = {
  orgId: string;
  planId: string;
  customerId: string;
  /** The plan's `credits` component in the subscription's currency. */
  pack: Extract<PriceComponent, { model: 'credits' }>;
  returnUrl: string;
};

export type WebhookRequest = {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
};

/** Contract with services/worker-py/worker/billing.py (BillingEvent); change both together. */
export type BillingEvent = {
  provider: string;
  contour: string;
  /** Unique per provider event: the workflow id, so a redelivered webhook is applied once. */
  eventId: string;
  type:
    | 'subscription.activated'
    | 'subscription.renewed'
    | 'subscription.past_due'
    | 'subscription.canceled'
    | 'payment.succeeded'
    | 'payment.failed'
    /** A paid credit pack: the worker grants the plan's pack value once per eventId. */
    | 'credits.purchased'
    /** A paid invoice of an org that checked out with a referral (docs/growth.md). */
    | 'referral.converted'
    /** A refund or dispute of a referred org's payment: its pending referral reward is void. */
    | 'referral.voided';
  orgId: string;
  /** ISO time the provider produced the event; older events never overwrite newer state. */
  occurredAt: string;
  planId?: string;
  currency?: string;
  customerId?: string;
  subscriptionId?: string;
  periodStart?: string;
  periodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  /** Purchased seats of a per_seat price. */
  seats?: number;
  /** Contract reference (order form, PO number), from the subscription's metadata. */
  contractRef?: string;
  /** payment.succeeded: amount in minor units and the invoice; referral.converted: referrer. */
  amount?: number;
  invoiceId?: string;
  referrerOrgId?: string;
};

export class WebhookRejected extends Error {}
export class ProviderNotConfigured extends Error {}
