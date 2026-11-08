import type { Subscription } from './entitlements.ts';
import type { PriceComponent, PriceModel } from './plans.ts';

/**
 * A payment provider, normalized (docs/billing.md "Adding a provider"). Nothing here is
 * provider-specific: an adapter maps its own objects to these shapes.
 */
export interface BillingProvider {
  readonly id: string;
  /** What this provider does; the routes and the billing page ask instead of assuming. */
  capabilities(): Capabilities;
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
}

export type Capabilities = {
  checkout: boolean;
  portal: boolean;
  cancel: boolean;
  /** Price models (config/plans.json `model`) this provider can sell. */
  priceModels: PriceModel[];
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
    | 'payment.failed';
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
};

export class WebhookRejected extends Error {}
export class ProviderNotConfigured extends Error {}
/** The provider cannot do this (see capabilities()); the route answers 409. */
export class NotSupported extends Error {}
