# 0030. Rewards as code, applied through the billing provider

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
- **Provider-neutral interface**: one `invoicing` field (`provider` | `external`) and optional
  `applyCredit()` (customer balance: it pays flat, per-seat and metered invoices alike, so no
  separate credit-grant path) and `applyCoupon()` (added to existing discounts). Without a provider
  customer the rule's entitlement fallback applies on our side.
- **Once per subject, cap under a lock**: the worker reserves the row in one transaction under
  `pg_advisory_xact_lock(org, rule)` (no row for the subject, cap not reached), then applies, then
  settles it. Temporal's REJECT_DUPLICATE and the provider's idempotency key both expire; the row
  does not.
- **Never drop a reward**: what no primitive can apply (manual contract, no adapter, provider down
  for good) is recorded as `pending_manual`, with an audit row; operators apply it and mark it in
  the console with a reason.
- **`reward_grants` is never deleted by the app**, and only its settlement columns may be updated
  (column-level GRANT); an operator's resolution is an audit row. `entitlements()` and the worker's
  LLM spend check read unexpired entitlement rows.

- **Referrals**: native = the provider's promotion code per org (first-time customers only) and a
  `referral.converted` billing event that starts the referrer's RewardWorkflow; connect = Dub
  Partners with `DUB_API_KEY` only, plain fetch (no SDK). No self-hostable affiliate engine meets the
  license and stack rules: Dub's partner and conversion code is its commercial `ee`, and its
  self-hosting needs Tinybird, Upstash and Vercel.

## Alternatives

- Stripe credit grants: they apply only to metered prices with Meters, and the customer balance
  already pays metered invoices; a second credit path is not worth it.
- A generic rules/loyalty engine or a SaaS (referral or loyalty platforms): more surface than three
  rule kinds need, and a second source of billing truth.
- Client-side reward triggers: forgeable.

## Consequences

- `invitation.accepted` counts an account once across all organizations (its first accepted
  invitation); deleting an organization deletes its invitations, which reopens that account.
  Keep free fallbacks non-monetary.
- Money amounts are two-decimal currencies; others are refused by the schema until billing has a
  minor-unit map.
- If the API link fails after the provider applied a reward, the grant is `pending_manual`;
  operators look up its idempotency key at the provider before applying it again.
