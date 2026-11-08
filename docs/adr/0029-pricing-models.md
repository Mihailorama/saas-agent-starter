# 0029. Billing without an assumed pricing model or payment rail

Status: accepted (owner rule, 2026-11-08: the boilerplate must not assume a pricing model or a
payment rail; research on Stripe Meters, credit grants and OSS engines on 2026-11-08). Number to
be renumbered at merge if taken.

## Context

ADR 0019 shipped plans with one flat recurring price per currency, sold through Stripe Checkout.
Products built on the starter sell per seat, by usage (pay as you go), with prepaid credit packs,
as a base fee plus overage, and as enterprise contracts that are invoiced outside any payment
provider. None of that should need changes to the billing core, and we must not write a rating
engine (tiers, proration, invoices). Usage: [docs/billing.md](../billing.md) "Pricing models".

## Decision

- **A price is a list of components with a `model`**: `flat`, `per_seat`, `metered`,
  `contract`. `config/plans.json` mirrors the provider's catalog: each component names the
  provider's price object; the provider rates and invoices, so tiers live only there. A price
  object without `model` is `flat` (expand/contract: older files keep working); a hybrid is
  `flat` + `metered`, prepaid is `metered` + `credits`. Amounts carry the currency's minor-unit decimals. One Zod schema in the
  API and the matching dataclasses in the worker.
- **Provider capabilities are optional methods**: an adapter has `checkout`, `portal`,
  `cancel` (and what later features add) or not, plus one `invoicing: 'provider' | 'external'`
  field. Routes and the billing page check for the method instead of assuming Stripe's
  feature set; no separate capabilities object to keep in step.
- **`manual` provider** for contracts invoiced outside any PSP, selected by the plan's
  `contract` price (`"provider": "manual"`), not by a flag. The operator console writes plan,
  currency, period and contract reference (audited) and starts a Temporal timer
  (`ContractPeriodWorkflow`) in the same transaction; at the period end it marks the subscription
  `past_due` unless it was extended. The console refuses a contract while another provider's
  subscription is active, so nobody is billed twice. Contracts the provider invoices (Stripe
  `send_invoice`) are created in the provider's dashboard with `metadata.orgId` and arrive
  through the webhook: one path that writes provider state, no second API client for it.
- **A subscription keeps the provider it was made with** (`subscriptions.provider`), so a manual
  contract can sit in a Stripe contour.
- **Usage goes to the provider's meters, rating stays there.** One worker activity per org and
  run sends one event per meter and closed hour (`<meter>:<org>:<hour>`, so the provider
  deduplicates retries), moving a per-org mark (`subscriptions.usage_reported_until`) after each
  hour; a failing org never stalls the others, and hours past the provider's 35-day window are
  skipped, not retried forever. On pay-as-you-go plans the plan's LLM limit becomes a warning and
  the org's own cap (else `llmSpendMax`) the hard stop. The worker holds the meter adapter
  (Stripe REST via the installed `httpx2`), because usage and the gateway live there.
- **Prepaid credits are provider credit grants.** A paid pack (one-time checkout) becomes one
  grant of the plan's pack value in the provider (audit check plus an idempotency key per
  payment; failures raise and are recorded). The gateway compares the provider's balance with
  the period's not yet invoiced spend before a priced call. No local credit ledger.
- **Entitlements per model**: per seat, the purchased quantity is the seat limit (from the
  provider's webhook); limits otherwise come from the plan and operator overrides.

## Alternatives

- **An OSS catalog/entitlement library**: none small enough passed the license gate (ADR 0005).
- **OpenMeter** (Apache-2.0) as the metering engine: the "install" path for usage aggregation
  outside the provider; a separate adapter later, not the default.
- **Orb, Metronome** (hosted usage billing) and **Polar** (merchant of record): further
  "connect" adapters behind the same interface.
- **Our own rating engine and invoice ledger**: rejected; it duplicates the provider and becomes
  a payments system (ADR 0019).

## Consequences

- New pricing in Stripe is a config change: create the price objects, list them in plans.json.
- Per-seat quantity changes go through the provider's portal; the app does not push member
  counts to the provider.
- Contract renewals are an operator action; a forgotten renewal degrades to `past_due`, then to
  the default plan after the grace period, never silently to free service.
- Stripe's line items follow the model (metered prices take no quantity); other providers declare
  which models they sell in `priceModels`.
