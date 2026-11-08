import { type BillingProvider, WebhookRejected } from './provider.ts';

/**
 * Contracts invoiced outside any payment provider (docs/billing.md "Contract"). No checkout,
 * portal, cancel or webhooks: an operator records plan, period and contract reference in the
 * console (`PUT /api/admin/orgs/:id/contract`), and a Temporal timer marks the subscription
 * `past_due` when the period ends without a renewal.
 */
export const manualProvider: BillingProvider = {
  id: 'manual',
  invoicing: 'external',
  webhook: () => Promise.reject(new WebhookRejected('the manual provider has no webhooks')),
  dashboardUrl: () => null,
};
