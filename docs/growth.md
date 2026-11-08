# Rewards and growth loops

Design and alternatives: [ADR 0029](adr/0029-rewards.md). This page is the how-to.

Rewards are code: rules in `config/rewards.json`, one dispatcher, one workflow. There is no rules
engine beyond that file. Everything is behind the `rewards` feature flag (default off).

## What is where

- `config/rewards.json`: the rules. Read by the API (triggers, provider dispatch) and the worker
  (conditions, caps, grants). Validated by `apps/api/src/billing/rewards.ts` (`RewardsConfig`);
  `apps/api/test/rewards.test.ts` fails on a broken file.
- `reward_grants`: one row per reward, tenant table with RLS, unique on `(org_id, rule_id,
  subject)`: a rule rewards a subject once, ever. Reserved first, then settled; the app role may
  update only `status`, `via`, `reward`, `provider_ref` and `expires_at`, and never delete.
- `apps/api/src/billing/rewards.ts`: config, `triggerRewards()` (starts the workflow), `dispatch()`
  (the one dispatcher) and `applyReward()`. `entitlements()` adds unexpired entitlement rewards to
  the limits; the worker's LLM spend check does the same (`worker/billing.py`).
- `services/worker-py/worker/rewards.py` + `RewardWorkflow` (`worker/workflows.py`): hold timer,
  reserve (conditions, cap), apply, settle.
- Web: `/settings/members` (list members; admins invite by email with the onboarding checklist's
  `InviteDialog` and revoke pending invitations). Operators: "Rewards to apply" on the
  organization's page in `/admin` (docs/admin.md).

## A rule

```json
{
  "id": "team-invite",
  "trigger": "invitation.accepted",
  "reward": { "kind": "balance_credit", "amount": "5.00", "currency": "USD" },
  "fallback": { "kind": "entitlement", "key": "projects", "delta": 1, "months": 3 },
  "capPerOrg": 5,
  "holdDays": 14
}
```

- `trigger`: a **server-side** event. Client analytics events (`track()`) never grant anything;
  anyone can send them.
  - `invitation.accepted`: Better Auth's `afterAcceptInvitation` hook. Subject: the new member.
  - `org.profile_completed`: Better Auth's `afterUpdateOrganization` hook, when the organization's
    metadata has every key of the rule's `requiredMetadata`, all non-empty. The shipped rule uses
    `size` and `website`, the keys the onboarding "company details" dialog writes and the API
    validates (`OrgMetadata`, apps/api/src/auth.ts); a test keeps `requiredMetadata` within them.
    Subject: the organization.
  - `referral.converted`: the first paid invoice of a referred organization (Referrals below).
    Subject: the referred organization; the rewarded org is the referrer.
- `reward`, one of:
  - `{ "kind": "balance_credit", "amount": "5.00", "currency": "USD" }`: money. Two-decimal
    currencies only for now (the schema refuses JPY, KWD and the like);
  - `{ "kind": "coupon", "couponId": "..." }`: a provider coupon, added to the subscription's
    existing discounts;
  - `{ "kind": "entitlement", "key": "seats" | "projects" | "llmSpendMonthly", "delta": 2,
    "months": 3 }`: more of a plan limit for a while, on our side. `llmSpendMonthly` also names its
    `currency` and raises only that cost currency.
- `fallback` (optional entitlement): used when the provider cannot apply the money or coupon reward
  (no provider customer, other currency, no live subscription for a coupon). Keep it non-monetary
  (seats, projects): free organizations are the cheapest to farm.
- `capPerOrg`: grants of this rule per organization, ever. `holdDays`: the workflow waits this
  long, then checks the conditions.

## Flow

1. The trigger fires after Better Auth committed the change. `triggerRewards()` checks the flag and
   starts `RewardWorkflow` with id `reward-<org>-<rule>-<subject>` and `REJECT_DUPLICATE`. A
   Temporal outage never fails the user's action (Sentry gets the error).
2. The worker sleeps `holdDays` (a Temporal timer), then **reserves** the grant in one transaction
   under an advisory lock on (org, rule): no row yet for this subject (so the reward is never paid
   twice, also after Temporal's retention forgot the workflow id), cap not reached, organization
   not suspended, and per trigger: the invited user is still a member, has a verified email, and
   this is the account's **first accepted invitation anywhere** (one account cannot be re-invited
   by org after org); or the profile is still complete.
3. Entitlements apply on our side. Money and coupons go to the API, which owns the billing
   provider: `POST /internal/rewards/apply` with `INTERNAL_API_TOKEN`, keyed by the workflow id,
   which is also the provider's idempotency key.
4. The row is settled (`applied` or `pending_manual`) with an audit row (`reward.applied` or
   `reward.pending_manual`). Metric `rewards.granted` (labels `rule`, `via`).

## Behaviour per pricing model

The provider declares `invoicing` (`provider`, or `external` for a manual contract) and implements
`applyCredit` and `applyCoupon` if it can (docs/billing.md). The dispatcher uses the org's
`subscriptions` row:

| Organization's billing                                           | Money reward                                    | Coupon reward                    | Entitlement reward |
| ---------------------------------------------------------------- | ----------------------------------------------- | -------------------------------- | ------------------ |
| Flat, per-seat, usage-based or prepaid, invoiced by the provider | customer balance credit: pays the next invoices | coupon added to the subscription | ours               |
| Provider customer without a live subscription                    | customer balance credit                         | fallback                         | ours               |
| Free (no provider customer)                                      | fallback entitlement                            | fallback                         | ours               |
| Manual contract (`invoicing: 'external'`) or no adapter          | `pending_manual` for operators                  | `pending_manual`                 | ours               |
| API link missing, or the API/provider keeps failing              | `pending_manual`                                | `pending_manual`                 | ours               |

A reward with no fallback that cannot be applied automatically is also `pending_manual`. Nothing is
silently dropped: operators see each pending grant on the organization's console page with its
idempotency key and provider reference. **Check the provider for that key first** (look the request with
that idempotency key up in the provider's request logs): when the API timed out after the provider
succeeded, the credit exists already. Otherwise apply it as a credit note or invoice line, then mark
it applied (an `operator.reward.applied` audit row with the reference).

## Referrals

Flag `referrals` (default off). Two ways, side by side; `DUB_API_KEY` picks:

|               | Native (install, default)                                                                                                                                                                                                                                      | Dub Partners (connect)                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup         | a coupon in the provider; its id in `rewards.json` `referral.couponId`                                                                                                                                                                                         | `DUB_API_KEY` on the API; program, rewards and coupons configured in Dub                                                                     |
| Link          | `/settings/referrals`: `<app>/sign-in?ref=<code>`. Code and provider promotion code (Stripe: `first_time_transaction`) are created once, on the first view                                                                                                     | `/settings/referrals`: the org's partner link (`POST /partners`, `tenantId` = org id), created once and kept in `organization.referral_link` |
| Capture       | `?ref=` (or Dub's `?dub_id=`) stays in the sign-up URL, nothing is stored in the browser; the sign-up sends it as the `referralCode` field (`user.referral_code`, sign-up only: update-user cannot set it)                                                     | same field: Dub's click id                                                                                                                   |
| Attribution   | the user's first organization gets `referred_by` = the referring org, once                                                                                                                                                                                     | `referred_by = 'dub'`, lead sent to Dub (`/track/lead`, customer = org id)                                                                   |
| Referred side | checkout applies the referrer's promotion code; the provider limits it to a first payment                                                                                                                                                                      | Dub's dual-sided coupon (on its side)                                                                                                        |
| Conversion    | the subscription's **first** paid invoice (`billing_reason: subscription_create`, amount > 0) emits `referral.converted` (`audit_log` row `billing.referral.converted`) and starts the referrer's `RewardWorkflow` (rule `referral`, needs flag `rewards` too) | each paid invoice goes to Dub (`/track/sale`); Dub pays partners. Do not also install Dub's Stripe app, or sales count twice                 |

Fraud guards (native): no self-referral (a member of the referring org creating a new org); not the
same payer (a saved card fingerprint shared by the referrer's and the referred customer, checked
by the API before the workflow starts); a 30-day hold, after which the referred subscription must
still be `active` (refunds and chargebacks cancel it); and the rule's cap and one grant per
referred org. `referral.blockSameEmailDomain` (off by default, since free-mail domains match too)
also refuses orgs whose owners share an email domain. A Dub or provider error never fails the
billing webhook: Sentry gets it (a Dub sale lost that way is not retried).

## Add a rule

1. Append it to `config/rewards.json`; `pnpm --filter api test rewards` validates it.
2. For a coupon, create the coupon in the provider first and use its id.
3. A new trigger: add it to `TRIGGERS` (rewards.ts), its condition to `_conditions()` in
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
