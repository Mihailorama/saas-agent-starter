import type { Subscription } from './entitlements.ts';
import type { Price } from './plans.ts';

/**
 * A payment provider, normalized (docs/billing.md "Adding a provider"). Nothing here is
 * provider-specific: an adapter maps its own objects to these shapes.
 */
export interface BillingProvider {
  readonly id: string;
  /** Hosted payment page for the first period of `planId`; returns where to send the browser. */
  checkout(input: CheckoutInput): Promise<{ url: string }>;
  /** Hosted self-service page (invoices, payment method), or null if the provider has none. */
  portal(sub: Subscription, returnUrl: string): Promise<string | null>;
  /** Stop renewing at the end of the paid period. */
  cancel(sub: Subscription): Promise<void>;
  /** Verifies a webhook and maps it to events; throws WebhookRejected if it is not authentic. */
  webhook(req: WebhookRequest): Promise<BillingEvent[]>;
  /** The subscription in the provider's own dashboard, for operators (docs/admin.md). */
  dashboardUrl(sub: Subscription): string | null;
  /** What this provider can do, independent of any one customer (docs/billing.md). */
  capabilities(): ProviderCapabilities;
  /** Whether the customer has usage-based (metered) prices; needed only with `creditGrants`. */
  usageBased?(sub: Subscription): Promise<boolean>;
  /** Credits money (`balanceCredit` / `creditGrants`); returns the provider object's id. */
  applyCredit?(sub: Subscription, credit: Credit): Promise<string>;
  /** Applies a provider coupon to the recurring charge (`coupons`); returns the object's id. */
  applyCoupon?(sub: Subscription, coupon: { couponId: string; key: string }): Promise<string>;
  /** Referrals: a promotion code for `couponId`, valid on first payments only; returns its id. */
  createPromotionCode?(p: {
    code: string;
    couponId: string;
    referrerOrgId: string;
    key: string;
  }): Promise<string>;
}

/**
 * Provider capabilities. Rewards read only these keys (docs/growth.md); other billing features
 * add theirs to the same object.
 */
export type ProviderCapabilities = {
  /** `external`: invoices are issued outside the provider (manual contract): rewards go to operators. */
  invoicing: 'provider' | 'external';
  /** A credit on the customer's balance, used by the next invoices. */
  balanceCredit: boolean;
  /** Credits restricted to usage-based (metered) charges, e.g. Stripe billing credit grants. */
  creditGrants: boolean;
  /** Percentage or fixed discounts (coupons) on a recurring charge. */
  coupons: boolean;
};

export type RewardPrimitive = 'credit_grant' | 'balance_credit' | 'coupon';
export type Credit = {
  via: 'credit_grant' | 'balance_credit';
  /** Decimal string in major units ("5.00"), in `currency` (ISO 4217, the customer's). */
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
  price: Price;
  /** Provider customer id from an earlier subscription, if any. */
  customerId: string | null;
  /** Page the provider sends the user back to (`?checkout=success|canceled` is appended). */
  returnUrl: string;
  /** Referred org (docs/growth.md): the referrer's promotion code, echoed back on payments. */
  referral?: { promotionCode: string; referrerOrgId: string };
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
    /** A paid invoice of an org that checked out with a referral (docs/growth.md). */
    | 'referral.converted';
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
  /** payment.succeeded: amount in minor units and the invoice; referral.converted: referrer. */
  amount?: number;
  invoiceId?: string;
  referrerOrgId?: string;
};

export class WebhookRejected extends Error {}
export class ProviderNotConfigured extends Error {}
