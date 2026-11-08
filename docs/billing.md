# Billing, plans and LLM spend limits

Design and alternatives: [ADR 0019](adr/0019-billing.md), pricing models
[ADR 0029](adr/0029-pricing-models.md). This page is the how-to.

## What is where

- `config/plans.json`: plans (id, limits: seats, projects, monthly LLM spend per currency;
  `llmSpendMax`; feature flags), prices per currency (one or more components with a pricing
  `model`, see [Pricing models](#pricing-models)) with the provider's price id, and the
  billing **contours** (a contour names one provider and its currencies; the template ships
  `en` = Stripe in USD/EUR). `PLANS_FILE` (API and worker) points at another file. Versioned
  with the
  code; the API and the worker both read it. The web never hard-codes a price: the billing page
  gets plans and prices from `GET /api/billing`.
- `subscriptions` table: the organization's current plan, status (`incomplete`, `active`,
  `past_due`, `canceled`), period, provider references and admin-raised LLM limits. A tenant
  table with RLS like the others; no row means the default plan. **Not a payments ledger**:
  invoices, receipts and payment history stay in the provider (Stripe: its customer portal).
- `apps/api/src/billing/`: `plans.ts` (config), `entitlements.ts` (`entitlements(orgId)`,
  `requireEntitlement`, `llmSpend`), `provider.ts` (the provider interface, its
  optional methods and normalized events), `money.ts` (`minorUnits`, `toMinor`, `fromMinor`),
  `stripe.ts`, `manual.ts` (contracts invoiced outside
  any provider), `registry.ts` (contour -> configured provider).
  Routes: `apps/api/src/routes/billing.ts`.
- `services/worker-py/worker/billing.py`: the LLM spend check used by `Gateway.call_llm`,
  and applying provider events to `subscriptions`.

## Pricing models

The template assumes no pricing model and no payment rail. A plan's price in a currency is one
component or an array of components, each with a `model`; `config/plans.json` mirrors the
provider's catalog (the price objects you create there) and the provider does the rating:
tiers, proration, taxes and invoices. There is no rating engine here. A price object without
`model` (the format before) is read as `flat`, so older files keep working. Every model below is
in the test fixture `apps/api/test/fixtures/plans.json`.

| `model`    | Fields                                                                          | Sold by                                      |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| `flat`     | `amount`, `interval`, `providerPriceId`                                         | checkout                                     |
| `per_seat` | `amount` per seat, `interval`, `providerPriceId`                                | checkout, quantity = members                 |
| `metered`  | `meter`, `interval`, `providerPriceId`                                          | checkout, no quantity                        |
| `credits`  | `meter`, `pack: {credits, amount}`, `expiresDays`, `providerPriceId` (one-time) | "Buy credits" on the billing page            |
| `contract` | `provider` (`manual` or `stripe`), `providerPriceId`                            | the operator console or the Stripe dashboard |

Rules (checked when the file is read): at most one `flat` or `per_seat` component; a `contract`
stands alone; `credits` need a `metered` component on the same meter (credit grants apply to
metered prices only); amounts have exactly the currency's minor-unit decimals (`"29.00"`, JPY `"3000"`,
KWD `"9.500"`). Meters: `llm_cost_micros` (AI cost in millionths of the cost currency),
`llm_tokens`, `api_calls` (requests with an organization API key).

`entitlements()` reads the model of the plan in force (`models`): per seat, the purchased
quantity is the seat limit; the others use the plan's limits. The billing page shows the base
price, "per seat", "+ usage", "Pay as you go" or "Contact us" from the same data; a plan gets an
"Upgrade" button only where the contour's provider sells all its components through checkout
(the provider has `checkout`).

### Flat

One recurring price, the shipped default (`pro`):
`{"model": "flat", "amount": "29.00", "interval": "month", "providerPriceId": "price_..."}`.

### Per seat

`{"model": "per_seat", "amount": "12.00", "interval": "month", "providerPriceId": "price_..."}`,
the price per seat. Checkout subscribes with quantity = current members; the seat limit is the
purchased quantity (`subscriptions.seats`, from the provider's webhook). To add seats the
customer changes the quantity in the provider's portal (Stripe: enable quantity updates in the
portal settings). An operator override (`limit_overrides`) still wins.

### Usage-based (pay as you go)

`{"model": "metered", "meter": "llm_cost_micros", "interval": "month", "providerPriceId": ...}`
with the provider's metered price (Stripe: a price on a
[Meter](https://docs.stripe.com/billing/subscriptions/usage-based) whose event name is the
`meter`, customer mapping `stripe_customer_id`, value key `value`, aggregation sum). Checkout
adds it without quantity. Behind the flag `billing-usage` (default off), evaluated per
organization in the API and the worker alike:

- **Reporting** (`worker/usage.py`): `UsageReportWorkflow` runs every 15 minutes (Temporal
  Schedule `billing-usage-report`) and starts one `report_org_usage` activity per organization,
  each with its own retries, so a failing org never holds up the others. An org's progress is
  `subscriptions.usage_reported_until`. Each closed hour after it (closed 5 minutes ago) is
  aggregated and sent as one event per meter, identifier `<meter>:<org>:<hour>`, and the mark
  moves after every hour; a retry or re-run resends the same identifiers, which Stripe drops for
  24 hours (`duplicate_meter_event`). Meters of the plan in effect during that hour:
  - `llm_cost_micros`: the hour's successful `ai_calls` cost in the subscription's currency, in
    millionths, rounded once. Cost in another currency is not put on the meter (a warning in the
    log): price your models in the currency you bill, or bill each currency on its own plan;
  - `llm_tokens`: the hour's `total_tokens` (calls through an org's own provider excluded);
  - `api_calls`: the hour's API-key requests (`usage_counters`, counted by `requireScope`;
    sessions do not count).

  Stripe takes events up to 35 days old: older hours are skipped with a warning instead of
  blocking the org, and one run catches up at most 72 hours per org. Worker env:
  `STRIPE_SECRET_KEY` (empty: no reporting), `STRIPE_API_URL` for stripe-mock.
- **Spend limit**: on a plan with a metered LLM price (`llm_cost_micros` or `llm_tokens`) the
  plan's `llmSpendMonthly` only warns (worker log, "warning" on the billing page) because the
  usage is billed. Calls stop at the organization's own cap (the raised limit an admin or
  operator set) or, without one, at the plan's `llmSpendMax`. Flat and other plans: as before.

### Hybrid (base + overage)

An array: `flat` (or `per_seat`) plus `metered`. Included usage is a free first tier of the
metered price, set up in the provider.

### Prepaid credits

`metered` plus `{"model": "credits", "meter": "llm_cost_micros", "pack": {"credits": 1000,
"amount": "10.00"}, "expiresDays": 365, "providerPriceId": "price_..."}` (a one-time price): the
subscription carries the metered price (checkout subscribes to it), and the customer buys packs
on top. Behind the flag `billing-credits` (default off):

- **Top-up**: "Buy N credits" on the billing page (`POST /api/billing/credits/checkout`, admins)
  opens a one-time Stripe Checkout for the pack, for the org's Stripe customer (`topUp`).
  `pack.credits` is the number shown; the grant is `pack.amount`.
- **Grant after payment**: `checkout.session.completed` (or `.async_payment_succeeded`) with
  `payment_status: paid` becomes `credits.purchased`, with the Checkout Session id as event id.
  `BillingEventWorkflow` then runs `grant_credits` in the worker: it checks the audit trail
  (`billing.credits.granted` for that session means done), then creates a Stripe
  [credit grant](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits) of
  the plan's pack value (never the amount paid, which includes tax and discounts; category
  `paid`, metered prices, expiring after `expiresDays`) with the idempotency key
  `credits-<session id>`. Up to 20 attempts, inside Stripe's 24-hour key window. A pack that
  cannot be granted (no plan, pack, provider key or customer) or still fails on the last attempt
  raises (Sentry) and writes `billing.credits.grant_failed`: grant it by hand in the dashboard.
- **Balance check**: Stripe applies credit only when it finalizes an invoice, so before a priced
  AI call the gateway compares the provider's available balance with this period's spend from
  `ai_calls` (the same sum as the spend limit) and refuses the call with `SpendLimitExceeded`
  when nothing is left. The balance is read at most every 30 s per org; while Stripe is down the
  last one read in the past 10 minutes is used, and with none the call goes ahead (the usage is
  billed anyway). The billing page shows the same remainder. No local ledger: the balance is
  Stripe's.

### Contract

Negotiated terms for one customer, on a plan with a `contract` price. Customers see "Contact us"
instead of a checkout. Seats and projects beyond the plan: "Adjust limits" in the console
(`limit_overrides`, up to the plan's `limitsMax`).

- `{"model": "contract", "provider": "manual"}`: invoiced outside any payment provider (your
  accounting, bank transfer). The operator sets it on the organization page in the console
  (`PUT /api/admin/orgs/:id/contract`: plan, currency, contract reference, period; reason
  required; audit row `operator.contract.set`). It is refused (409) while the organization has an
  active or past-due subscription with another provider, so nobody is billed twice. In the same
  transaction the console starts `ContractPeriodWorkflow` (`billing-contract-<org>-<period end>`),
  a durable Temporal timer; if Temporal is down nothing is saved. At the period end the
  subscription becomes `past_due` (the plan holds for `pastDueGraceDays`), or `canceled` if it was
  set to end (organization deletion). Setting the contract again with a later period end is the
  renewal; the old timer then does nothing. No checkout, portal or cancel button.
- `{"model": "contract", "provider": "stripe", "providerPriceId": "price_..."}`: Stripe sends
  the invoices, the customer pays by bank transfer. Create the subscription in the Stripe
  dashboard on that price with "Email invoice to the customer" (`collection_method:
  send_invoice`, `days_until_due` as agreed) and the metadata `orgId` (the organization id from
  the console) and optionally `contractRef`. Its state arrives through the webhook like a
  checkout's.

## Provider capabilities

What a provider can do is which optional methods its adapter has (`checkout`, `portal`,
`cancel`, `topUp`, `creditBalance`, and in the worker `report_usage` / `credit_balance` /
`grant_credits`, the `reportUsage` / `creditBalance` / `grantCredits` of the surface); routes and the billing page check for them instead
of assuming Stripe's feature set. One field says who sends invoices: `invoicing: 'provider'`
(Stripe) or `'external'` (`manual`: no checkout, portal or cancel). A subscription is served by
the provider it was made with (`subscriptions.provider`), so a `manual` contract can sit in a
Stripe contour.

## Connect vs install

The template connects to a provider that rates and invoices; it does not rate usage itself. When
that stops being enough:

- **OpenMeter** (Apache-2.0): the "install" option, a self-hosted metering and entitlement
  service for usage aggregation outside the payment provider (follow-up).
- **Orb** or **Metronome**: hosted usage billing for complex contracts and rating (connect;
  follow-up).
- **Polar**: a merchant of record (sales tax, invoices in its name) with checkout and usage
  billing (connect; follow-up).

Each is another provider adapter behind the same interface, plus a meter adapter in the worker
(`Meters` in `worker/usage.py`: `report_usage(customer, meter, value, identifier, at)`, the
`reportUsage` of the provider surface).

## Entitlements

`entitlements(orgId)` answers "what may this org do": plan, limits, features, billing period
and the effective LLM limit per currency. The paid plan applies while the subscription is
`active`, and while `past_due` until `pastDueGraceDays` after the paid period; otherwise the
org is on `defaultPlan`.

Guards, after `requireRole`:

```ts
preHandler: [requireRole('member'), requireEntitlement('projects', countProjects)]; // limit
preHandler: [requireRole('admin'), requireEntitlement('llmLimitRaise')]; // feature
```

A blocked request gets `402 {"error": "plan limit reached: projects"}`. Seats are enforced by
Better Auth's `membershipLimit` (add member, accept invitation), fed from the same function.
A feature flag that no plan defines fails at startup, so typos do not silently pass.
An operator may override seats and projects for one organization up to the plan's optional
`limitsMax` (`organization.limit_overrides`, docs/admin.md); `entitlements()` applies it.

## LLM spend limit

Before every AI call the gateway sums `ai_calls.cost` of the org for the current billing period
(the paid period, else the calendar month in UTC) in the model's cost currency, and compares it
with the plan's `llmSpendMonthly` (or the admin- or operator-raised value, capped by `llmSpendMax`):

- from 80%: a warning in the worker log and on the billing page;
- at 100%: the call is refused with the non-retryable `SpendLimitExceeded`; the project summary
  activity then simply stores no summary, and the billing page says "AI features are paused".

The sum is one index range scan on `ai_calls (org_id, created_at)` (checked by
`tests/test_billing.py`). Prices: an explicit `pricePer1kTokens` in `config/ai-models.json` wins;
otherwise the gateway takes the model's price from LiteLLM's bundled model cost map (USD; vendor
APIs and aggregators only, a zero price counts as unknown). A model with neither **fails closed**:
the gateway refuses it with `ModelNotAllowed`, because its calls could not be counted. Mark a
model `"unmetered": true` only when it has no per-call cost to you: CLI subscriptions and
self-hosted models. The shipped placeholder `example-self-hosted-model` is neither priced nor
unmetered, so it is refused until you configure it. `pnpm check:ai-prices` (part of
`pnpm check`) lists every model without an explicit price. Every cost currency in
`ai-models.json` (USD for map-priced models) needs a limit in every plan;
`apps/api/test/billing.test.ts` checks that.

## LLM usage limit (unmetered models)

Unmetered models have no cost to cap, so the plan caps their use instead:
`limits.llmUsageMonthly` with `calls` and/or `tokens` per billing period (same period as the
spend limit). Before a call of an unmetered model the gateway counts the org's successful calls
and their `total_tokens` across all unmetered models of the contour and refuses at the limit with
the non-retryable `UsageLimitExceeded` (a subclass of `SpendLimitExceeded`, handled the same way
by the activities). Metric: `billing_llm_usage_blocked_total` by `plan` and `unit`. A plan
without `llmUsageMonthly` leaves unmetered models unlimited. Calls through an organization's own
provider (feature `byoLlm`, docs/llm-providers.md) are not limited by either: the org pays its
provider directly.

Metrics (worker, OTLP -> Prometheus), labelled by `plan` and `currency`, never by org:
`billing_llm_spend_ratio` (histogram of spend/limit at each call) and `billing_llm_blocked_total`.
Alert `LlmSpendLimitHit` in `infra/otel/alerts.yml` fires when calls are being refused.

## Provider flow

1. An admin clicks "Upgrade": `POST /api/billing/checkout {planId}` asks the contour's provider
   for a hosted payment page and redirects there.
2. The provider calls `POST /api/billing/webhooks/<provider>`. The adapter verifies it and maps
   it to normalized events (`subscription.activated|renewed|past_due|canceled`,
   `payment.succeeded|failed`).
3. Each event starts `BillingEventWorkflow` with workflow id `billing-<provider>-<event id>`
   (`REJECT_DUPLICATE`): a redelivered webhook is applied once. The activity is idempotent on
   its own as well: an event older than the stored state is ignored, and its audit row
   (`billing.<type>`, target `<provider>:<event id>`) is written once. If Temporal is down the
   webhook answers 5xx and the provider retries.
4. "Invoices and payment method" opens the provider portal (Stripe); "Cancel plan" stops renewal
   at the period end.

## Setup per contour

The contour of new subscriptions is `BILLING_CONTOUR` (`en` in the template); an org that already has a
subscription keeps its contour. Set `AI_CONTOUR` on the API too, so the billing page shows the
LLM spend in the currencies of your models.

### `en`: Stripe

1. In the Stripe dashboard create a product per paid plan and a recurring price per currency;
   put the price ids into `config/plans.json` (`providerPriceId`).
2. Configure the [customer portal](https://docs.stripe.com/customer-management) (cancel, payment
   method, invoices). Plan changes made there arrive as `customer.subscription.updated`; the
   adapter maps the price id back to the plan.
3. Add a webhook endpoint `https://<your app>/api/billing/webhooks/stripe` with the events
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, and for credit
   packs `checkout.session.completed`, `checkout.session.async_payment_succeeded`.
4. Env (API; forwarded by `compose.prod.yaml`, set in `deploy/env/<env>.enc.env`):
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (the endpoint's signing secret);
   leave `STRIPE_API_URL` empty. Signatures are checked with the SDK's `constructEventAsync`.

Payment-provider merchant onboarding is outside the template: the merchant entity, the
provider contract and its review of your site, and any local tax or receipt rules your market
has.

## Test mode

No real provider keys anywhere, including CI.

- Stripe: `docker compose --profile billing up -d stripe-mock` (Stripe's official mock, MIT). The
  `.env.example` defaults (`STRIPE_SECRET_KEY=sk_test_123`, `STRIPE_API_URL`) point the SDK at
  it. stripe-mock validates requests against Stripe's OpenAPI spec and returns fixtures; it does
  not keep state or send webhooks, so tests sign fixture events with
  `stripe.webhooks.generateTestHeaderStringAsync`. For a real test-mode account use your
  `sk_test_...` key, empty `STRIPE_API_URL`, and the Stripe CLI (`stripe listen --forward-to
  localhost:3000/api/billing/webhooks/stripe`).
- Local dev without any keys: checkout answers 503 "billing is not configured"; everything else
  works on the default plan.

## Adding a provider

A provider is one file implementing `BillingProvider` (`apps/api/src/billing/provider.ts`).
Nothing in the interface is Stripe-shaped.

1. **Adapter**: `invoicing`, `checkout` (optional: hosted payment page for the first period
   with the plan's components as line items; put `orgId` and `planId` into metadata the provider
   echoes back), optional `portal` (a hosted self-service page, or `null`),
   `cancel` (stop renewing at period end), `webhook` (verify, then map to `BillingEvent`s with a
   stable `eventId` so redeliveries are deduplicated). Verify webhooks with the provider's
   documented mechanism: a signature if it signs, otherwise what it documents instead (for
   example sender address ranges, and re-reading the object from its API and trusting only the
   re-read copy). Throw `WebhookRejected` when verification fails. `dashboardUrl` links the
   subscription (or customer) in the provider's own dashboard for operators (docs/admin.md), or
   `null`.
2. **Wiring**: env vars in `apps/api/src/env.ts` (no real values in `.env.example`), a branch
   in `registry.ts`, its id in the contract `provider` enum (`plans.ts`) if it takes contracts, a contour in `config/plans.json` with its currencies, prices per currency
   (`providerPriceId: null` if the provider takes the amount with each payment).
3. **Recurring billing**: if the provider renews subscriptions itself (as Stripe does), its
   renewal and failure webhooks map to `subscription.renewed` / `subscription.past_due` and you
   are done. If it only offers charging a **saved payment method**, the app must schedule the
   renewals:
   - save the method's reference with the first payment (add a column to `subscriptions` and a
     field to `BillingEvent`);
   - on `subscription.activated`/`renewed`, have `BillingEventWorkflow` start a child workflow
     with id `billing-renewal-<org>-<period end>` (parent close policy `ABANDON`) that sleeps
     until the period end (a durable Temporal timer) and then runs a charge activity in the
     worker;
   - the activity re-reads the subscription and does nothing if it was renewed, replaced or
     canceled meanwhile (`cancel_at_period_end` -> set `canceled` instead of charging);
   - send an idempotency key derived from org and period end, and keep activity retries within
     the provider's idempotency window, so a retry can never charge twice;
   - let the charge's result arrive through the webhook like the first payment, so there is
     one path that changes state.
4. **Tests** against the provider's official mock or recorded responses; no real keys, in CI
   or anywhere in the repo. Add a container mock to `docker-compose.yml` under the `billing`
   profile and list it in docs/LICENSES.md.
