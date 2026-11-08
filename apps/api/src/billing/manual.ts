import { type BillingProvider, NotSupported, WebhookRejected } from './provider.ts';

/**
 * Contracts invoiced outside any payment provider (docs/billing.md "Contract"). No checkout,
 * portal or webhooks: an operator records plan, period and contract reference in the console
 * (`PUT /api/admin/orgs/:id/contract`), and a Temporal timer marks the subscription `past_due`
 * when the period ends without a renewal.
 */
export const manualProvider: BillingProvider = {
  id: 'manual',
  capabilities: () => ({
    checkout: false,
    portal: false,
    cancel: false,
    priceModels: ['contract'],
  }),
  checkout: () => Promise.reject(new NotSupported('contracts are set up by an operator')),
  portal: async () => null,
  cancel: () => Promise.reject(new NotSupported('a contract ends by its own terms')),
  webhook: () => Promise.reject(new WebhookRejected('the manual provider has no webhooks')),
  dashboardUrl: () => null,
};
