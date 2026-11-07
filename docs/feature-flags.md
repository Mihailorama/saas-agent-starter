# Feature flags

New user-visible behaviour ships dark, behind a flag, and is turned on step by step: first for
the team, then for a share of users or organizations, then for everyone; after that the flag and
the old code path are deleted. Flags are evaluated by PostHog's built-in feature flags (the same
PostHog project as product analytics, [ADR 0012](adr/0012-product-analytics.md)); the repo keeps
only the catalog and one small wrapper per runtime. There is no flag service, store or table of
our own. Decision record: [ADR 0020](adr/0020-feature-flags-and-releases.md).

## What is in the repo

| Piece        | Where                                | What it does                                                              |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------- |
| Flag catalog | `config/flags.json`                  | Name, description, owner, default, expiry date of every flag              |
| API          | `apps/api/src/flags.ts`              | `await isEnabled('name', { userId, orgId, plan })` via `posthog-node`     |
| Web          | `apps/web/src/lib/flags.ts`          | `useFlag('name')` in components, `isEnabled('name', ctx)` elsewhere       |
| Worker       | `services/worker-py/worker/flags.py` | `await is_enabled("name", user_id=..., org_id=...)` via the `posthog` SDK |
| CI rail      | `pnpm check:flags` (in `pnpm check`) | Unknown or non-literal names fail; expired or unused flags warn           |
| Sync         | `pnpm flags:sync [--dry-run]`        | Creates missing catalog flags in PostHog                                  |

## Catalog

```json
"new-project-form": {
  "description": "Two-step project creation form.",
  "owner": "@example",
  "default": false,
  "expires": "2027-03-31"
}
```

- Name: lowercase, digits, `-` or `_`; it is the PostHog flag key.
- `description`: what the user sees change, so support can tell which behaviour a user has.
- `owner`: the GitHub handle or team that finishes the rollout and removes the flag.
- `default`: the value whenever PostHog gives no answer: PostHog not configured, flag not created
  or inactive there, network error. `false` for new behaviour.
- `expires`: the date by which the rollout is finished and the flag removed from code and catalog.
  After it, `pnpm check` prints a warning naming the owner (it does not fail the build).

## Evaluation

Every runtime evaluates in the same order:

1. `FLAGS_ON` / `FLAGS_OFF` (comma-separated flag names) win over everything, PostHog included.
   In the web they are build-time `VITE_FLAGS_ON` / `VITE_FLAGS_OFF`. Use them for local
   development, tests, a deployment-wide kill switch, and tiers without PostHog.
2. PostHog, when configured. The person is the internal user id (the same distinct id the web
   sends with `identify()`), the organization is the PostHog group `organization`, and `plan` is
   passed as a group property when the caller has one (the starter has no plans yet).
3. The catalog `default`.

So the code path is identical with and without PostHog; only the source of the answer differs.

| Tier                            | Flags come from                          | Gradual rollout                         |
| ------------------------------- | ---------------------------------------- | --------------------------------------- |
| PostHog Cloud (default)         | PostHog, then the catalog default        | Per user, per organization, by property |
| Umami-only, on-prem, RU contour | Catalog default + `FLAGS_ON`/`FLAGS_OFF` | Per deployment only (on or off for all) |
| Self-hosted PostHog (client VM) | That PostHog (`POSTHOG_HOST`)            | As PostHog Cloud                        |

Without PostHog there is no per-user or percentage rollout: a deployment has the flag on or off.
That is the honest limit of "no own flag store"; if a client on those tiers needs percentage
rollouts, the replacement is a self-hosted flag service (see ADR 0020), not code in this repo.

### Env

- API and worker: `POSTHOG_KEY` (project key `phc_...`, public) and `POSTHOG_HOST`
  (`https://eu.i.posthog.com` or `https://us.i.posthog.com`; empty = PostHog's US default), the
  same project and region as the web's `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST`.
- Optional, API and worker: `POSTHOG_SECRET_KEY`, a project secret API key with the
  `feature_flag:read` scope ("Local feature flag evaluation" preset in PostHog's project
  settings). Server-side only.

### Remote or local evaluation

- Default, remote: needs only the public project key. Each check is one `/flags` request
  (`flagKeys` limits it to the one flag), so it adds a network round trip to the request and is
  billed as one flag request (PostHog: first 1M flag requests per month free).
- Local, with `POSTHOG_SECRET_KEY`: `posthog-node` (API) and the `posthog` Python SDK (worker)
  poll the flag definitions every 30 s and evaluate in process, no request per check. Costs one
  more secret per deployment; a poll is
  billed as 10 flag requests when the definitions changed and is free when they did not (ETag,
  `304`), per [PostHog's billing docs](https://posthog.com/docs/billing/estimating-usage-costs)
  (checked 2026-11-07). Flags that need person properties PostHog stores but we do not pass
  still fall back to a remote request.

The worker uses the official `posthog` Python SDK (`worker/flags.py`) the same way: remote with
the project key, local with `POSTHOG_SECRET_KEY`. The SDK is synchronous, so each check runs in a
thread (`asyncio.to_thread`) and never blocks the worker's event loop. Like the API and the web,
every answered check sends a `$feature_flag_called` exposure event (queued, flushed on shutdown),
so experiments count exposures from the worker too. A check PostHog does not answer (unknown
flag, network error, quota) falls back to the catalog default, as before.

We default to remote because it needs no extra secret; set the secret key when flag checks sit
on hot paths or the request volume makes per-check billing larger than the polling cost.

### Web specifics

- PostHog loads only after the user accepts the analytics banner (ADR 0012). Before that, and
  for users who decline, every flag is its catalog default (or `VITE_FLAGS_ON`/`OFF`). A
  rollout therefore reaches consenting users only; users without consent get the new behaviour
  when the flag is removed after full rollout. The API and worker do not depend on consent, so a
  feature that spans both must work when the web shows the old path and the API the new one
  (the usual case: the API adds an endpoint the old web does not call).
- `useFlag()` re-renders when PostHog's flags load or change, and points PostHog at the signed-in
  user and active organization (it reloads flags when the organization changes).
- Organization-level targeting needs PostHog's group analytics, a paid add-on. Without it, roll
  out by user percentage or person properties; the code does not change.

## Rollout steps (for coding agents)

1. Add the flag to `config/flags.json` with `"default": false`, an owner and an expiry date a few
   weeks out. Guard the new behaviour with `isEnabled('<name>', ...)` / `useFlag('<name>')` /
   `is_enabled("<name>", ...)`; keep the old path working. Test both paths (`FLAGS_ON=<name>` in
   tests or `flagEvaluator` with an override).
2. `pnpm flags:sync --dry-run`, then `pnpm flags:sync` (needs `POSTHOG_PERSONAL_API_KEY` with
   `feature_flag:write`) creates the flag in PostHog at 0 %.
3. Roll out in PostHog: internal users or one organization, then a percentage (e.g. 10 %, 50 %),
   watching the journey funnels and errors (`pnpm journeys:report`, PostHog MCP). Rollout changes
   happen in PostHog, never through `flags:sync` (it only updates the description).
4. At 100 % for a few days with no regressions, open a PR that removes the flag: delete the old
   path and every `isEnabled` call, remove the catalog entry, then archive the flag in PostHog.
   `pnpm check:flags` warns about catalog flags no longer used in code and about expired ones.

Without PostHog (on-prem, RU) step 3 is "set `FLAGS_ON=<name>` on the deployment", and step 4 is
the same.

## Rules

- New user-visible behaviour ships behind a catalog flag. Bug fixes, refactors and internal
  changes do not need one.
- Call the wrapper with a literal name; never call PostHog's flag API directly and never keep
  flag state in our database.
- A flag is temporary: it has an owner and an expiry date and is removed after full rollout.
  Long-lived configuration belongs in env or the database, not in flags.
- Do not put personal data in flag context: ids and the plan only.
