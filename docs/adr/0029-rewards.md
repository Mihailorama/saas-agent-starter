# 0029. Rewards as code, applied through the billing provider

Status: accepted (owner decision, 2026-11-08: rewards and referrals; any pricing model, including
contracts invoiced outside a payment provider)

## Context

Growth loops (invite your team, complete your profile, refer a customer) need rewards that are
cheap to change, safe against abuse, and correct for every pricing model the boilerplate supports:
flat, per-seat, usage-based, prepaid credits, and custom contracts with no payment provider at all.
Free organizations have no provider customer. Usage: [docs/growth.md](../growth.md).

## Decision

- **Rules as code**: `config/rewards.json` (trigger, reward, fallback, cap, hold), validated by a
  Zod schema in the API, read by the worker. One dispatcher (`dispatch()`), no rules engine.
- **Triggers are server-side events only** (Better Auth hooks after commit, later webhooks). A
  client analytics event can be forged; it never grants anything.
- **RewardWorkflow (Temporal)** per rule and subject, id `reward-<org>-<rule>-<subject>`,
  `REJECT_DUPLICATE`: the hold is a durable timer, the conditions (verified member still in the
  org, profile complete, cap) are checked after it, and retries are free.
- **Provider calls stay in the API.** The adapters (`apps/api/src/billing`, `BillingProvider`) are
  TypeScript and hold the provider keys; the worker has none. So the worker asks the API to apply
  a money or coupon reward (`POST /internal/rewards/apply`, shared `INTERNAL_API_TOKEN`, not
  proxied by the web origin), with the workflow id as the provider's idempotency key. A second
  provider client in Python would duplicate every adapter and its keys; a TypeScript Temporal
  worker inside the API would add `@temporalio/worker` (native core bridge, workflow bundler) to
  every API replica for two calls.
- **Provider-neutral interface**: `capabilities()` (`invoicing: provider | external`,
  `balanceCredit`, `creditGrants`, `coupons`) plus optional `usageBased()`, `applyCredit()`,
  `applyCoupon()`. The dispatcher picks the native primitive: Stripe credit grants (billing
  credits) for metered prices, the customer balance for invoiced subscriptions, coupons for
  discounts, an entitlement bump on our side without a provider customer.
- **Never drop a reward**: what no primitive can apply (manual contract, no adapter, provider down
  for good) is recorded as `pending_manual`, with an audit row; operators apply it and mark it in
  the console with a reason.
- **`reward_grants` is append-only** like `ai_calls`: an operator's resolution is an audit row,
  not an update. `entitlements()` and the worker's LLM spend check read unexpired entitlement rows.

## Alternatives

- Stripe credit grants for everything: they apply only to metered prices with Meters, so they do
  nothing for flat or per-seat plans and cannot reach free organizations.
- A generic rules/loyalty engine or a SaaS (referral or loyalty platforms): more surface than three
  rule kinds need, and a second source of billing truth.
- Client-side reward triggers: forgeable.

## Consequences

- Concurrent grants of one org can overshoot `capPerOrg` by the number in flight (check-then-act);
  an advisory lock is the upgrade if it matters.
- `applyCoupon` replaces the subscription's discounts on Stripe; stacking needs a merge.
- Money amounts are two-decimal currencies; zero-decimal currencies need their own minor unit.
- If the API link fails after the provider applied a reward, the grant is `pending_manual`;
  operators check the provider before applying it again.
