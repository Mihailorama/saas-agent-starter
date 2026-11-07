# Billing, plans and LLM spend limits

Design and alternatives: [ADR 0019](adr/0019-billing.md). This page is the how-to.

## What is where

- `config/plans.json`: plans (id, limits: seats, projects, monthly LLM spend per currency;
  `llmSpendMax`; feature flags), prices per currency with the provider's price id, and the
  billing **contours** (`en` = Stripe in USD/EUR, `ru` = YooKassa in RUB). Versioned with the
  code; the API and the worker both read it. The web never hard-codes a price: the billing page
  gets plans and prices from `GET /api/billing`.
- `subscriptions` table: the organization's current plan, status (`incomplete`, `active`,
  `past_due`, `canceled`), period, provider references and admin-raised LLM limits. A tenant
  table with RLS like the others; no row means the default plan. **Not a payments ledger**:
  invoices, receipts and payment history stay in the provider (Stripe portal; YooKassa merchant
  dashboard and the 54-FZ receipts it sends).
- `apps/api/src/billing/`: `plans.ts` (config), `entitlements.ts` (`entitlements(orgId)`,
  `requireEntitlement`, `llmSpend`), `provider.ts` (the provider interface and normalized
  events), `stripe.ts`, `yookassa.ts`, `registry.ts` (contour -> configured provider).
  Routes: `apps/api/src/routes/billing.ts`.
- `services/worker-py/worker/billing.py`: the LLM spend check used by `Gateway.call_llm`,
  applying provider events to `subscriptions`, and YooKassa renewals.

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
`tests/test_billing.py`). Models with an unknown price (`pricePer1kTokens: null`, e.g. the `ru`
placeholder in `config/ai-models.json`) produce rows without cost and are **not** limited: give
every model you enable a price. Every priced currency in `ai-models.json` needs a limit in every
plan; `apps/api/test/billing.test.ts` checks that.

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

The contour of new subscriptions is `BILLING_CONTOUR` (`en` or `ru`); an org that already has a
subscription keeps its contour. Set `AI_CONTOUR` on the API too, so the billing page shows the
LLM spend in the currencies of your models.

### EN: Stripe

1. In the Stripe dashboard create a product per paid plan and a recurring price per currency;
   put the price ids into `config/plans.json` (`providerPriceId`).
2. Configure the [customer portal](https://docs.stripe.com/customer-management) (cancel, payment
   method, invoices). Plan changes made there arrive as `customer.subscription.updated`; the
   adapter maps the price id back to the plan.
3. Add a webhook endpoint `https://<your app>/api/billing/webhooks/stripe` with the events
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
4. Env (API): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (the endpoint's signing secret);
   leave `STRIPE_API_URL` empty. Signatures are checked with the SDK's `constructEventAsync`.

### RU: YooKassa

1. Your shop must be allowed to make autopayments: per
   [YooKassa](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/basics)
   they are only available in the demo store by default; ask your YooKassa manager to enable
   them, and show users the autopayment terms (frequency, amount, how to opt out).
2. Set the prices in RUB in `config/plans.json` (`providerPriceId: null`: YooKassa takes the
   amount per payment).
3. In the merchant dashboard set the HTTP notification URL to
   `https://<your app>/api/billing/webhooks/yookassa` with `payment.succeeded` and
   `payment.canceled`.
4. Env: `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` on the API **and** the worker (the worker
   charges renewals). Behind a reverse proxy set `TRUST_PROXY=true`, or the IP check sees the
   proxy's address and rejects every notification.

How it works: the first payment is created with `save_payment_method: true` and a redirect
confirmation. YooKassa has no subscription object, so when a period is activated the worker
starts `SubscriptionRenewalWorkflow`, a Temporal timer until the period end; then it creates an
autopayment with the saved `payment_method_id`
([docs](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved))
and an `Idempotence-Key` derived from org and period, so retries cannot charge twice (YooKassa
keeps idempotence for 24 hours,
[interaction format](https://yookassa.ru/developers/using-api/interaction-format)). The result
arrives as a notification like the first payment. Cancel means we stop charging: YooKassa has
nothing to cancel, the renewal workflow ends the subscription instead.

YooKassa notifications are not signed. Following
[their guidance](https://yookassa.ru/developers/using-api/webhooks) ("Notification
authentication") the adapter checks both that the sender IP is in YooKassa's published ranges
(`YOOKASSA_IPS` in `yookassa.ts`; re-check the list there when YooKassa changes it) and that the
payment's current status, re-read with `GET /v3/payments/{id}`, matches the notification. Only
the re-read object is used.

**Outside this template**: the Russian merchant entity (legal entity or sole proprietor), the
contract with YooKassa and the acquirer's moderation of your site, and fiscalization under 54-FZ.
If your shop sends receipts through YooKassa, payments need a `receipt` object (customer contact
and items with VAT codes); add it in `yookassa.ts` checkout and in the worker's renewal body as
your fiscal setup requires.

## Test mode

No real provider keys anywhere, including CI.

- Stripe: `docker compose --profile billing up -d stripe-mock` (Stripe's official mock, MIT). The
  `.env.example` defaults (`STRIPE_SECRET_KEY=sk_test_123`, `STRIPE_API_URL`) point the SDK at
  it. stripe-mock validates requests against Stripe's OpenAPI spec and returns fixtures; it does
  not keep state or send webhooks, so tests sign fixture events with
  `stripe.webhooks.generateTestHeaderStringAsync`. For a real test-mode account use your
  `sk_test_...` key, empty `STRIPE_API_URL`, and the Stripe CLI (`stripe listen --forward-to
  localhost:3000/api/billing/webhooks/stripe`).
- YooKassa: the API tests stub `fetch` with responses in the shape of the documented examples
  (`apps/api/test/fixtures/yookassa/`); the worker tests use `httpx2.MockTransport`. For a live
  check create a YooKassa [demo store](https://yookassa.ru/developers/payment-acceptance/testing-and-going-live/testing)
  and use its id and key; their docs list test cards, and recurring payments need a test card
  without 3-D Secure.
- Local dev without any keys: checkout answers 503 "billing is not configured"; everything else
  works on the default plan.

## Adding a provider (e.g. CloudPayments)

1. Implement `BillingProvider` (`apps/api/src/billing/provider.ts`) in a new file: `checkout`,
   `portal` (or `null`), `cancel`, `webhook` (verify with the provider's documented mechanism,
   throw `WebhookRejected` otherwise; map to `BillingEvent`s with a stable `eventId` and the
   org id from metadata you set at checkout).
2. Register it in `registry.ts` with its env, and add a contour to `config/plans.json`.
3. If the provider has no recurring billing of its own, add its id to `RENEWED_BY_WORKER` and a
   charge function in `worker/billing.py` (`charge_renewal`).
4. Tests against its official mock or recorded fixtures; no real keys.
