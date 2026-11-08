# Rewards and growth loops

Design and alternatives: [ADR 0029](adr/0029-rewards.md). This page is the how-to.

Rewards are code: rules in `config/rewards.json`, one dispatcher, one workflow. There is no rules
engine beyond that file. Everything is behind the `rewards` feature flag (default off).

## What is where

- `config/rewards.json`: the rules. Read by the API (triggers, provider dispatch) and the worker
  (conditions, caps, grants). Validated by `apps/api/src/billing/rewards.ts` (`RewardsConfig`);
  `apps/api/test/rewards.test.ts` fails on a broken file.
- `reward_grants`: one row per granted reward, tenant table with RLS, **append-only** (the app role
  has no UPDATE or DELETE). Unique on `(org_id, rule_id, subject)`, so a rule rewards a subject once.
- `apps/api/src/billing/rewards.ts`: config, `triggerRewards()` (starts the workflow), `dispatch()`
  (the one dispatcher) and `applyReward()`. `entitlements()` adds unexpired entitlement rewards to
  the limits; the worker's LLM spend check does the same (`worker/billing.py`).
- `services/worker-py/worker/rewards.py` + `RewardWorkflow` (`worker/workflows.py`): hold timer,
  conditions, cap, apply, record.
- Web: `/settings/members` (list members, invite by email, revoke pending invitations; admins).
  Operators: "Rewards to apply" on `/admin` (docs/admin.md).

## A rule

```json
{
  "id": "team-invite",
  "trigger": "invitation.accepted",
  "reward": { "kind": "balance_credit", "amount": "5.00", "currency": "USD" },
  "fallback": { "kind": "entitlement", "key": "llmSpendMonthly", "delta": 2, "months": 3 },
  "capPerOrg": 5,
  "holdDays": 14
}
```

- `trigger`: a **server-side** event. Client analytics events (`track()`) never grant anything;
  anyone can send them.
  - `invitation.accepted`: Better Auth's `afterAcceptInvitation` hook. Subject: the new member.
  - `org.profile_completed`: Better Auth's `afterUpdateOrganization` hook, when the organization's
    metadata has every key of the rule's `requiredMetadata`, all non-empty. The shipped rule uses
    `size` and `website`, the keys the onboarding "company details" dialog writes. Code that writes
    organization metadata elsewhere (an onboarding flow) calls `triggerRewards('org.profile_completed',
    { orgId, subject: orgId, userId, metadata })` after its commit. Subject: the organization.
  - `referral.converted`: reserved for referrals.
- `reward`, one of:
  - `{ "kind": "balance_credit", "amount": "5.00", "currency": "USD" }`: money (two-decimal
    currencies);
  - `{ "kind": "coupon", "couponId": "..." }`: a provider coupon (percentage or fixed discount);
  - `{ "kind": "entitlement", "key": "seats" | "projects" | "llmSpendMonthly", "delta": 2,
    "months": 3 }`: more of a plan limit for a while, on our side. `llmSpendMonthly` adds `delta`
    in every cost currency.
- `fallback` (optional entitlement): used when the provider cannot apply the money or coupon reward
  (no provider customer, other currency, no such primitive).
- `capPerOrg`: grants of this rule per organization, ever. `holdDays`: the workflow waits this
  long, then checks the conditions.

## Flow

1. The trigger fires after Better Auth committed the change. `triggerRewards()` checks the flag and
   starts `RewardWorkflow` with id `reward-<org>-<rule>-<subject>` and `REJECT_DUPLICATE`. A
   Temporal outage never fails the user's action (Sentry gets the error).
2. The worker sleeps `holdDays` (a Temporal timer), then checks: organization not suspended, cap
   not reached, and per trigger: the invited user is **still a member with a verified email**
   (abuse guard against throw-away accounts), or the profile is still complete.
3. Entitlements are recorded directly. Money and coupons go to the API, which owns the billing
   provider: `POST /internal/rewards/apply` with `INTERNAL_API_TOKEN`, keyed by the workflow id,
   which is also the provider's idempotency key, so a retry never credits twice.
4. The grant row and an audit row (`reward.applied` or `reward.pending_manual`) are written once.
   Metric `rewards.granted` (labels `rule`, `via`).

## Behaviour per pricing model

The dispatcher picks the native primitive for the organization's billing setup, from the provider's
`capabilities()` (`invoicing`, `balanceCredit`, `creditGrants`, `coupons`) and the org's
`subscriptions` row (docs/billing.md):

| Organization's billing                                                  | Money reward                                   | Coupon reward              | Entitlement reward |
| ----------------------------------------------------------------------- | ---------------------------------------------- | -------------------------- | ------------------ |
| Usage-based / pay-as-you-go (metered prices)                            | provider credit grant (Stripe billing credits) | coupon on the subscription | ours               |
| Prepaid credit bundles (metered usage)                                  | provider credit grant on the metered usage     | coupon                     | ours               |
| Flat or per-seat subscription (licensed)                                | customer balance credit, on the next invoice   | coupon                     | ours               |
| Customer without a live subscription                                    | customer balance credit                        | fallback                   | ours               |
| Free (no provider customer)                                             | fallback entitlement                           | fallback                   | ours               |
| Manual contract, invoiced outside any PSP                               | `pending_manual` for operators                 | `pending_manual`           | ours               |
| Provider not configured, API link missing or the provider keeps failing | `pending_manual`                               | `pending_manual`           | ours               |

A reward with no fallback that cannot be applied automatically is also `pending_manual`. Nothing is
silently dropped: operators see each pending grant in the console, apply it as a credit note or
invoice line, and mark it applied (an `operator.reward.applied` audit row with the reference).
A provider that cannot tell metered customers apart (no `usageBased()`) never gets credit grants.

## Add a rule

1. Append it to `config/rewards.json`; `pnpm --filter api test rewards` validates it.
2. For a coupon, create the coupon in the provider first and use its id.
3. A new trigger: add it to `TRIGGERS` (rewards.ts), its condition to `eligible()` in
   `worker/rewards.py`, and call `triggerRewards()` after the commit of the change that fires it.

## Local and test setup

`INTERNAL_API_TOKEN` and `API_INTERNAL_URL` are in `.env.example`; compose sets the worker's to
`http://api:3000`. Money rewards use stripe-mock in tests; the worker's tests use canned HTTP for
the API. Turn the flag on with `FLAGS_ON=rewards`.

## Privacy

`reward_grants` holds ids only: the subject is a user id for invitation rewards. Exported with the
organization and with the user (rows where they are the subject); kept after a user's erasure like
`ai_calls` (a random id, the org's billing record), deleted with the organization row
(docs/privacy.md).
