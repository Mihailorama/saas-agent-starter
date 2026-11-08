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

- **A price is a list of components with a `model`**: `flat`, `per_seat`, `metered`, `credits`,
  `contract`. `config/plans.json` mirrors the provider's catalog: each component names the
  provider's price object; the provider rates and invoices. `tiers` and packs are for display.
  A price object without `model` is `flat` (expand/contract: older files keep working); a hybrid
  is `flat` + `metered`. One Zod schema in the API and the matching dataclasses in the worker.
- **Provider capabilities**: `BillingProvider.capabilities()` returns `{checkout, portal,
  cancel, priceModels, usageReporting, creditBalance, merchantOfRecord, invoicing}`. Routes and
  the billing page ask it instead of assuming Stripe's feature set; optional methods (`invoice`
  now) exist only where a provider has them.
- **`manual` provider** for contracts invoiced outside any PSP, selected by the plan's
  `contract` price (`"provider": "manual"`), not by a flag. The operator console writes plan,
  currency, period and contract reference (audited), and a Temporal timer
  (`ContractPeriodWorkflow`) marks the subscription `past_due` at the period end unless it was
  extended. Contracts that the provider invoices (Stripe `collection_method: send_invoice` with
  `days_until_due`) are created by the same console action through the provider's API.
- **A subscription keeps the provider it was made with** (`subscriptions.provider`), so a manual
  contract can sit in a Stripe contour.
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
