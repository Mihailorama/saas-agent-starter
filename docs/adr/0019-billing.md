# 0019. Billing: plans as config, swappable payment providers, LLM spend limits

Status: accepted

## Context

Products built on the starter sell plans with limits (seats, projects, LLM usage) in more than
one market. The owner's decisions: payments sit behind a provider interface chosen per
country/contour (the template ships Stripe; other markets add their provider), prices differ
per currency, and every organization has an LLM spend limit checked against the cost already
recorded in `ai_calls` (ADR 0008). We must not become a payments system ourselves.

## Decision

- **Plans as versioned config** (`config/plans.json`): limits, feature flags, `llmSpendMonthly`
  and `llmSpendMax` per currency, prices per currency with the provider's price id, and the
  contours (provider + currencies). One file, read by the API (Zod) and the worker; the web gets
  prices from the API. A plan catalogue in the database would need an admin UI and migrations
  for every price change; config changes are reviewed like code.
- **One entitlement function** `entitlements(orgId)` and a `requireEntitlement` guard for limits
  and features (402 when not included). Seats use Better Auth's `membershipLimit` hook with the
  same function.
- **Subscription state is domain data** in a `subscriptions` tenant table (RLS): plan, status,
  period, provider references, admin-raised LLM limits. Invoices, receipts and payment history
  stay in the provider; the UI links to the provider portal. No payments ledger, no amounts.
- **Provider interface** in the API: `checkout`, `portal` (nullable), `cancel`, `webhook` ->
  normalized events (`subscription.activated|renewed|past_due|canceled`,
  `payment.succeeded|failed`). Nothing in it is Stripe-shaped: no customers, prices or
  invoices leak through; an adapter maps its own objects.
  - Stripe: the official `stripe` SDK (MIT, no dependencies). Stripe owns the subscription and
    renews it; signatures checked with `constructEventAsync`.
  - Providers that only charge a saved payment method fit the same interface; the app then
    schedules renewals with a Temporal timer per period (docs/billing.md "Adding a provider").
- **Webhooks through Temporal**: the API verifies and normalizes, then starts
  `BillingEventWorkflow` with the provider event id as workflow id (`REJECT_DUPLICATE`), like
  every other workflow here (ADR 0004). The activity is idempotent on its own (older events
  never overwrite newer state; audit rows once per event). The worker is Python-only: a
  TypeScript Temporal worker fails the license gate (webpack's `caniuse-lite` is CC-BY-4.0) and
  has no musl build for the Alpine API image, so the API only starts workflows.
- **LLM spend limit in the gateway**: `Gateway.call_llm` sums the org's `ai_calls.cost` for the
  billing period (index range scan on `(org_id, created_at)`) before every call, warns from 80%
  and refuses at 100% with the non-retryable `SpendLimitExceeded`. The worker emits
  `billing_llm_spend_ratio` and `billing_llm_blocked_total` labelled by plan and currency, never
  by org.

## Alternatives

- **A billing platform** (Lago, Kill Bill, Chargebee, Stripe Billing for everything): Lago is
  AGPL-3.0 and another service; Kill Bill is a JVM service; Chargebee is SaaS. Worth it once
  usage-based invoicing, dunning and tax rules grow beyond plans with limits.
- **A rollup table for LLM spend**: cheaper reads at very high call volumes, but a second copy
  of `ai_calls` cost that can drift, and `ai_calls` is append-only. The index range scan over
  one org's period is enough until an org makes millions of calls per month; then add a
  monthly rollup maintained by the gateway in the same transaction as the insert.

## Consequences

- Prices and limits change by editing `config/plans.json` and deploying; existing subscriptions
  keep their plan id. Stripe price ids must exist in the Stripe account.
- Limits are check-then-act: concurrent requests (or AI calls) can overshoot a limit by one
  request (or one call's cost). Acceptable for plan limits; documented with `ponytail:`
  comments.
- Unpriced models fail closed: the gateway refuses them unless marked `"unmetered": true`
  (exempt from spend limits by explicit choice); `pnpm check:ai-prices` warns about both.
- Merchant onboarding with a provider (entity, contract, site review, local tax or receipt
  rules) is outside the template (docs/billing.md).
