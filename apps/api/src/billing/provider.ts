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
}

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
};

export class WebhookRejected extends Error {}
export class ProviderNotConfigured extends Error {}
