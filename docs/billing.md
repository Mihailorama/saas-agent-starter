# Billing, plans and LLM spend limits

Design and alternatives: [ADR 0019](adr/0019-billing.md). This page is the how-to.

## What is where

- `config/plans.json`: plans (id, limits: seats, projects, monthly LLM spend per currency;
  `llmSpendMax`; feature flags), prices per currency with the provider's price id, and the
  billing **contours** (a contour names one provider and its currencies; the template ships
  `en` = Stripe in USD/EUR). Versioned with the
  code; the API and the worker both read it. The web never hard-codes a price: the billing page
  gets plans and prices from `GET /api/billing`.
- `subscriptions` table: the organization's current plan, status (`incomplete`, `active`,
  `past_due`, `canceled`), period, provider references and admin-raised LLM limits. A tenant
  table with RLS like the others; no row means the default plan. **Not a payments ledger**:
  invoices, receipts and payment history stay in the provider (Stripe: its customer portal).
- `apps/api/src/billing/`: `plans.ts` (config), `entitlements.ts` (`entitlements(orgId)`,
  `requireEntitlement`, `llmSpend`), `provider.ts` (the provider interface and normalized
  events), `stripe.ts`, `registry.ts` (contour -> configured provider).
  Routes: `apps/api/src/routes/billing.ts`.
- `services/worker-py/worker/billing.py`: the LLM spend check used by `Gateway.call_llm`,
  and applying provider events to `subscriptions`.

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

## LLM spend limit

Before every AI call the gateway sums `ai_calls.cost` of the org for the current billing period
(the paid period, else the calendar month in UTC) in the model's cost currency, and compares it
with the plan's `llmSpendMonthly` (or the admin-raised value, capped by `llmSpendMax`):

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
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
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

1. **Adapter**: `checkout` (hosted payment page for the first period; put `orgId` and `planId`
   into metadata the provider echoes back), `portal` (a hosted self-service page, or `null`),
   `cancel` (stop renewing at period end), `webhook` (verify, then map to `BillingEvent`s with a
   stable `eventId` so redeliveries are deduplicated). Verify webhooks with the provider's
   documented mechanism: a signature if it signs, otherwise what it documents instead (for
   example sender address ranges, and re-reading the object from its API and trusting only the
   re-read copy). Throw `WebhookRejected` when verification fails.
2. **Wiring**: env vars in `apps/api/src/env.ts` (no real values in `.env.example`), a branch
   in `registry.ts`, a contour in `config/plans.json` with its currencies, prices per currency
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
