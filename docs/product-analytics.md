# Product analytics and user feedback

Coding agents need to see the product the way users do: which step of a journey loses people,
where users rage-click, which AI answers they reject, what they report as broken. This starter
does not keep its own event store. Events, funnels, session replay, heatmaps, surveys and
alerts live in external open-source tools with their own UI, APIs and integrations; the repo
holds only the contract (what we track, which journeys matter) and the glue. Decision record:
[ADR 0012](adr/0012-product-analytics.md).

## What is in the repo

| Piece                  | Where                                                       | What it does                                                                 |
| ---------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Event catalog          | `config/events.json`                                        | Every event name, description, props and PII flag                            |
| `track()`              | `apps/web/src/lib/analytics.ts`                             | One typed call, fans out to the configured sinks                             |
| Consent                | vanilla-cookieconsent, set up in `analytics.ts`             | Opt-in/opt-out per region, GPC, Google Consent Mode v2 ([below](#consent))   |
| CI rail                | `pnpm check:events` (in `pnpm check`)                       | Fails on uncatalogued events/props or non-literal names                      |
| Journeys (CJM as code) | `config/journeys.json`                                      | Ordered steps, conversion window, minimum conversion, step time targets      |
| Sync                   | `pnpm journeys:sync [--dry-run]`                            | Creates/updates PostHog funnels, alerts, surveys, webhooks and Umami funnels |
| Report                 | `pnpm journeys:report [--json]`                             | Prints current funnel numbers for agents and humans                          |
| Alert to issue         | `POST /api/hooks/posthog` (`apps/api/src/routes/hooks.ts`)  | PostHog webhook -> Plane work item `cjm-regression` / `from-users`           |
| AI-answer thumbs       | `aiFeedback()` in `analytics.ts`, buttons on the AI summary | PostHog AI observability survey + Langfuse score on the LLM call's trace     |
| Surveys (NPS, CSAT)    | `surveys` in `config/journeys.json` ([below](#surveys))     | PostHog popovers linked to a catalog flag; Formbricks when self-hosted       |
| Agent access           | `.mcp.json.example`                                         | PostHog MCP and Umami MCP for coding agents                                  |

Rage clicks, dead clicks, web vitals and JS exceptions are not our code: PostHog autocaptures
them (`$rageclick`, `$dead_click`, `$web_vitals`, `$exception`); Umami records web vitals
(`data-performance`) and offers heatmaps and replays on its tier.

## Tools and tiers

PostHog Cloud is the default for every tier and delivery, including thumbs feedback on AI
answers (PostHog AI observability). Umami and Langfuse are the fallbacks for clients, or the
RU contour, that forbid sending data outside (152-FZ data localization, enterprise policy).

| Tier                       | Analytics                                                                     | AI-answer feedback                                             | Notes                                             |
| -------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| S (one server)             | PostHog Cloud (EU or US region by env)                                        | PostHog AI observability                                       | Umami optional on the same server, measured below |
| M                          | PostHog Cloud                                                                 | PostHog AI observability; Langfuse if the team already uses it | Umami optional                                    |
| On-prem, no external calls | Umami (`--profile analytics`), or self-hosted PostHog on a separate client VM | Langfuse self-hosted                                           | All third-party sinks stay empty                  |
| RU contour                 | Umami; Yandex Metrika optional with consent where the client allows           | Langfuse self-hosted                                           | PostHog Cloud and GA4 off                         |

Every sink is off while its env var is empty. With nothing set, the browser makes no analytics
request at all; the Playwright smoke test asserts that every request goes to our own host.

### PostHog Cloud (default)

- Client: `posthog-js` (npm, `Apache-2.0 AND MIT`), loaded with a dynamic import only after
  consent. Init: `autocapture`, `capture_dead_clicks`, `capture_performance.web_vitals`,
  `capture_exceptions`; page views are sent by us with the route pattern
  (`/projects/$projectId`), never a URL with ids.
- Env (web build): `VITE_POSTHOG_KEY` (project key), `VITE_POSTHOG_HOST`
  (`https://eu.i.posthog.com` or `https://us.i.posthog.com`). CSP: set
  `ANALYTICS_ORIGINS="https://*.posthog.com"` on the `web` container; PostHog's
  [CSP guide](https://posthog.com/docs/advanced/content-security-policy) recommends the wildcard
  because the exact subdomains change (lazy-loaded scripts come from `eu-assets.i.posthog.com`
  / `us-assets.i.posthog.com`).
- Free tier: 1M events and 5K recordings per month; EU region is hosted in Frankfurt. Alerts
  work on trends, funnels (steps and trends views, threshold only, no anomaly detection on
  funnels) and SQL insights; 5 alerts on the free tier.
- Self-hosted PostHog (client VM only): 4 vCPU / 16 GB RAM / 30 GB disk minimum per PostHog's
  docs, officially unsupported ("hobby"), paid features are Cloud-only. Do not put it on the S
  server next to the app.
- Replacement criteria: replace if the client forbids data leaving its perimeter and a separate
  VM is not possible (-> Umami), or if PostHog drops funnel alerts/webhooks from the free tier.
  The replacement must offer funnels, an HTTP API to define them, and an alert or webhook path.

### Umami (self-hosted fallback)

- Umami 3 (MIT), PostgreSQL only. Funnels, journeys, retention, goals; session replay since
  v3.1.0, heatmaps since v3.2.0, MCP since v3.4.0 (`MCP_ENABLED=1`). No outgoing webhooks or
  alerts are documented.
- Run: `docker compose --profile analytics up -d` starts `umami` (port `UMAMI_PORT`, default
  3100) with its own database `umami` on our Postgres server (created by the one-shot
  `umami-db` service). `PRIVATE_MODE=1`, `DISABLE_TELEMETRY=1`, `DISABLE_UPDATES=1`: Umami
  calls nothing outside. Change `APP_SECRET` (`UMAMI_APP_SECRET`) and the default `admin` /
  `umami` login before exposing it.
- Web env: `VITE_UMAMI_SCRIPT_URL` (`https://umami.example.com/script.js`),
  `VITE_UMAMI_WEBSITE_ID`; CSP: add the Umami origin to `ANALYTICS_ORIGINS`. Cookieless and
  first-party (self-hosted), so it loads without the consent banner. Enabling Umami's replay or
  heatmaps records more: ask your DPO whether that needs consent in your jurisdiction.
- Scripts env: `UMAMI_URL`, `UMAMI_API_KEY` (Settings -> API keys), `UMAMI_WEBSITE_ID`.
- Measured on this repo (2026-11-06, `docker stats`, Umami 3.4.1 on the shared Postgres 17):
  ~256 MiB idle; peak ~780 MiB while ingesting ~75 events/s from 20 concurrent senders
  (12,750 events, 0 errors); back to ~256 MiB a minute later. Postgres grew from ~155 to
  ~185 MiB. Compose sets `mem_limit: 1g`. Fits the 8 CPU / 24 GB S server with room.
- Alerts: Umami has none. The planned path is Grafana from the `observability` profile
  (http://localhost:3001): a PostgreSQL datasource on the `umami` database and one alert rule
  per journey whose webhook contact point calls the API's hook receiver (extended for
  Grafana's payload); not built yet (docs/TODO.md). Until then run `pnpm journeys:report --json` on a schedule.
- Replacement criteria: replace if a client needs alerting/webhooks built in or ClickHouse-scale
  volume. Plausible CE is the mainstream alternative but is AGPL-3.0 and needs ClickHouse;
  Matomo (GPL-3.0, MySQL) is the other. Both are infra containers, allowed by ADR 0005.

### GA4 and Yandex Metrika (optional, consent-gated)

- Loaded only after consent and only when `VITE_GA4_ID` / `VITE_YM_ID` is set; off by default
  and never for on-prem. They never receive events marked `pii` in the catalog.
- Yandex Metrika: `VITE_YM_WEBVISOR=true` enables Webvisor (session replay). For the RU
  contour, use it only where the client allows a Yandex processor. CSP origins per Yandex's
  [CSP guide](https://yandex.com/support/metrica/en/code/install-counter-csp)
  (`https://mc.yandex.ru` and the domains it lists for Webvisor).
- GA4: CSP origins per Google's [CSP guide](https://developers.google.com/tag-platform/security/guides/csp).
- Replacement criteria: they exist because marketing teams ask for them; drop either when the
  team does not use it. They are never the source of truth for journeys.

### Consent

Third-party sinks sit behind [vanilla-cookieconsent](https://github.com/orestbida/cookieconsent)
(MIT, no dependencies), loaded only when one of them is configured. One optional category,
`analytics`; "necessary" is always on. Self-hosted Umami is not gated (cookieless, first-party).

- **opt-in** (default; GDPR + ePrivacy/PECR in the EU, EEA and UK, and wherever the region is
  unknown): nothing third-party loads until "Allow". "Only necessary" has the same weight.
  "Cookie settings" (user menu, and under the sign-in card) reopens the choices; withdrawing
  clears the sinks' cookies and reloads the page, so no sink keeps running.
- **opt-out** (US state privacy laws such as CCPA/CPRA): sinks start on the first visit, the
  banner informs, and the link reads "Do Not Sell or Share My Personal Information" (the CCPA
  regulations allow dropping it only under the frictionless-processing conditions). A Global
  Privacy Control signal (`navigator.globalPrivacyControl`, `respectGpc`) counts as opting out
  until the user decides otherwise; a saved choice always wins over the signal.
- **Google Consent Mode v2**, basic mode: gtag.js loads only after consent and first sets
  `gtag('consent', 'default', ...)` with everything `denied`, then grants `analytics_storage`.
  `ad_storage`, `ad_user_data` and `ad_personalization` stay `denied`: there is no ads category.
  If you run Google Ads, add a category and map those three signals to it.
- Bots (`navigator.webdriver`) get no banner and no sink (the library's `hideFromBots`).
- Events marked `pii` never reach third parties in either regime.

Choosing the regime needs no geo-IP service. The `web` container's nginx decides per request and
writes `<meta name="consent-mode">` into `index.html`:

| Env (web container)         | Default        | Meaning                                                                    |
| --------------------------- | -------------- | -------------------------------------------------------------------------- |
| `CONSENT_MODE`              | `opt-in`       | Regime for every visitor, unless a country below matches                   |
| `CONSENT_COUNTRY_HEADER`    | `cf_ipcountry` | nginx name of the edge's country header (`CF-IPCountry` on Cloudflare)     |
| `CONSENT_OPT_OUT_COUNTRIES` | empty          | Countries that get opt-out, as a regex alternation of ISO codes, e.g. `US` |

- EU or unknown audience: change nothing. US-only deployment: `CONSENT_MODE=opt-out`. Mixed
  traffic behind Cloudflare (`CF-IPCountry`, every plan including Free, once "IP geolocation" is
  on): `CONSENT_OPT_OUT_COUNTRIES=US`.
  CloudFront: `CONSENT_COUNTRY_HEADER=cloudfront_viewer_country` and add `CloudFront-Viewer-Country`
  to the origin request policy. Any other proxy that sets a country header works the same way.
- Trust the header only from your edge. If the app is reachable without it, strip the header at
  your proxy; otherwise a visitor can pick a regime for themselves.
- `index.html` now differs per country: keep HTML out of shared caches or add the country to the
  cache key.
- The Vite dev server has no nginx and is always opt-in.
- Limits, from the library's docs: it is not a CMP and keeps the choice only in its own cookie
  (no server-side consent records; the `consent_set` event is the trail you get), it does not
  implement the IAB TCF, and Google AdSense, Ad Manager and AdMob do not work with it.
- Replacement criteria: replace if releases stop (v3.1.0 in 2025-02 was followed by a 20-month
  gap before v3.2.0-v3.3.0 in 2026-10/11; one maintainer) or if a client needs the IAB TCF,
  consent records or Google's ad products; then use a certified CMP. Checked 2026-11-07: Klaro
  (BSD-3-Clause, last npm releases 0.7.21 and 0.7.22 on 2024-03-26, last commit 2025-03-27)
  and Osano's `cookieconsent` (MIT, last npm release 3.1.1 on 2019-05-23) were less maintained.

### AI-answer feedback (thumbs up/down)

The thumbs buttons on an AI summary call `aiFeedback()`, which sends:

1. the catalog event `ai_feedback` (purpose, rating, trace id) to every analytics sink;
2. a PostHog AI observability response when PostHog is loaded and
   `VITE_POSTHOG_AI_FEEDBACK_SURVEY_ID` / `VITE_POSTHOG_AI_FEEDBACK_QUESTION_ID` are set:
   a `survey sent` event with `$survey_id`, `$survey_response_<question id>` (1 = up,
   2 = down), `$ai_trace_id`, `$survey_submission_id`, `$survey_completed: true`
   ([manual feedback capture](https://posthog.com/docs/ai-observability/user-feedback/manual-event-capture)).
   `pnpm journeys:sync` creates the API survey ("AI answer feedback", one 2-point emoji rating)
   and prints both ids;
3. a Langfuse score when `VITE_LANGFUSE_PUBLIC_KEY` (and `VITE_LANGFUSE_HOST`) is set:
   `@langfuse/browser` `score({ traceId, name: 'user_feedback', value: 1|0, dataType: 'BOOLEAN' })`
   with the public key only.

The trace id is `ai_calls.trace_id`, the OpenTelemetry trace of the gateway's LLM span
(ADR 0008), exposed to members as `aiTraceId` on the project. Langfuse ingests that same OTel
trace, so the score lands on it. For PostHog the feedback lands on a trace only if the worker
also sends `$ai_generation` events with the same `$ai_trace_id` (not built yet, see
docs/TODO.md). A thumbs down also opens the correction form, so the corrected text is recorded
by the existing review flow (`ai_status = corrected`).

PostHog AI observability has a privacy mode: `privacy_mode=True` on the Python client (or the
`PostHogSpanProcessor`) drops prompts, outputs and error messages and keeps model, provider,
tokens, cost, latency and custom properties
([privacy mode](https://posthog.com/docs/ai-observability/privacy-mode)). Use it if the worker
ever sends generations, in line with ADR 0008 (content stays in our S3 only).

## Surveys

In-app surveys (NPS, CSAT, one-question micro-surveys) are config, like journeys: the `surveys`
block of `config/journeys.json`. Responses stay in the survey tool; there is no survey or
response table of ours.

|            | PostHog Cloud (default)                                                                 | Formbricks (connect your own, self-hosted contour)                                                   |
| ---------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Defined in | `config/journeys.json`, synced by `pnpm journeys:sync`                                  | the Formbricks UI (sync covers PostHog only)                                                         |
| Shown by   | `posthog-js` (already loaded after consent)                                             | `@formbricks/js` 5.1.0 (MIT), loaded after consent                                                   |
| Triggers   | catalog event and/or URL, wait period, re-ask schedule, linked flag                     | Formbricks actions: our survey trigger events are sent as actions with the same key, plus page views |
| Identity   | PostHog person = user id, `first_seen_at` set once                                      | `setUserId(user id)`, attribute `orgId`; never email or name                                         |
| Responses  | PostHog Surveys (results, insights, replays), deleted with the person (docs/privacy.md) | Formbricks                                                                                           |
| Env        | `POSTHOG_*` (sync), `VITE_POSTHOG_*` (web)                                              | `VITE_FORMBRICKS_ENV_ID`, `VITE_FORMBRICKS_API_HOST` (web build)                                     |

Each entry: `id`, `type` (`nps` 0-10 numbers, `csat` 1-5 emoji, `question` single choice with
`choices` or open text without), `question`, optional `followUp` (open text after the rating),
`trigger` (`event` from `config/events.json`, not `pii`, and/or `url`, matched as a substring),
`activeForDays` (only people first seen that many days ago or earlier), `waitDays` (skip people
who saw any survey in the last N days), `repeat` (`{ everyDays, times }`; absent = ask once) and
`flag`. Shipped: `nps` (project pages, active 14+ days, every 90 days, flag `nps-survey`) and
`csat-project` (after `project_created`, once, flag `csat-survey`). Both flags default off.

PostHog mapping, per survey `Survey: <id>`: a `popover`, `linked_flag_id` of the catalog flag (so
it shows only where the flag is on; create the flag first with `pnpm flags:sync`),
`conditions.url` (`icontains`), `conditions.events` (`page_view` = `$pageview`),
`conditions.seenSurveyWaitPeriodInDays`, `schedule` `once`/`recurring` with
`iteration_frequency_days` and `iteration_count`, and for `activeForDays` a
`targeting_flag_filters` group on the person property `first_seen_at` (`is_date_before -Nd`).
`identify()` sets `first_seen_at` with `$set_once`, so people who signed in before this shipped
count from their first visit after it. Sync compares each field with what PostHog has, PATCHes
only the changed ones (printed by name, also with `--dry-run`) and keeps question ids, so
responses stay joined to their question.

Add a survey:

1. Add the entry to `surveys` and a flag (`"default": false`, owner, expiry) to
   `config/flags.json`; `pnpm check:events` validates the entry, `pnpm check:flags` counts the
   linked flag as used.
2. `pnpm flags:sync`, then `pnpm journeys:sync --dry-run` to see the plan, then
   `pnpm journeys:sync`.
3. Roll out with the flag in PostHog (internal users, then a percentage), like any flag
   ([docs/feature-flags.md](feature-flags.md)). Stop a survey by turning its flag off; remove
   it by deleting the entry and archiving `Survey: <id>` in PostHog (sync never deletes).

Edit surveys in config, never in the PostHog UI: the next sync overwrites the fields it manages.

### Formbricks (connect your own)

For deliveries where data must stay in place (Umami tier, RU contour). Formbricks' core is
AGPLv3 with a commercial `ee` directory, and its stack (PostgreSQL, Redis and more services) is
heavier than this whole starter, so there is no compose profile: run it on its own host with
[Formbricks' Docker guide](https://formbricks.com/docs/self-hosting/setup/docker) and connect it.

1. In Formbricks, copy the Workspace ID and the SDK connection URL (Settings -> Workspace ->
   Web & Mobile SDK).
2. Set `VITE_FORMBRICKS_ENV_ID` (the Workspace ID) and `VITE_FORMBRICKS_API_HOST` (that URL)
   for the web build, and add the URL's origin to `ANALYTICS_ORIGINS` (CSP script and connect).
   Both empty = off: nothing loads, no request.
3. Create the surveys and their actions in Formbricks. The web sends page views and the
   trigger events of our `surveys` config as actions keyed by the event name (create an action
   with key `project_created` to reuse the CSAT trigger); other events are not sent.

User identification (contacts, attributes, segment targeting) is a Formbricks Enterprise
Edition feature ([docs](https://formbricks.com/docs/surveys/website-app-surveys/user-identification)).
Without a license, surveys still show by action and URL and responses are anonymous; the
`setUserId` and `setAttribute` calls are expected to be refused by the server (not tested here). The SDK pin is exact
(`5.1.0`) and needs a Formbricks 5 server (Workspace IDs).

## Journeys as code

`config/journeys.json`: per journey a `name`, `steps` (event names from the catalog),
`windowDays` (time to finish), `minConversion` (first-to-last-step conversion in % that
triggers the alert) and per step an optional `maxStepSeconds` (reported against PostHog's
median time to convert; not alerted on).

`pnpm journeys:sync` (idempotent, matches objects by name):

- PostHog (`POSTHOG_APP_HOST` e.g. `https://eu.posthog.com`, `POSTHOG_PROJECT_ID`,
  `POSTHOG_PERSONAL_API_KEY` with scopes `insight:write`, `alert:write`, `survey:write`,
  `feature_flag:read`, `hog_function:write`): one funnel insight `Journey: <name>` (ordered steps, conversion
  window), one hourly threshold alert (`FunnelsAlertConfig`, `conversion_from_start` below
  `minConversion`), the "Report a problem / suggest an improvement" survey (feedback tab
  widget on every page), the "AI answer feedback" API survey, the `surveys` of the config
  ([Surveys](#surveys)), and, when `PUBLIC_API_URL` and
  `POSTHOG_WEBHOOK_SECRET` are set, two webhook destinations: `$insight_alert_firing` and
  `survey sent` (feedback survey only) -> `${PUBLIC_API_URL}/api/hooks/posthog`. The feedback
  and AI surveys are created once and then left alone; config surveys are updated in place.
- Umami (`UMAMI_URL`, `UMAMI_API_KEY`, `UMAMI_WEBSITE_ID`): one saved funnel per journey
  (`POST /api/websites/{id}/funnels`, window in minutes).
- Without credentials, or with `--dry-run`, it prints every planned request instead.

Caveat: alert webhooks are created as PostHog hog functions (`template-webhook`) through the
API, the way PostHog's UI does it; the alerts API itself only creates Slack destinations. If
that API changes, add the webhook in the alert's UI ("Notifications" -> webhook) with the
same URL and an `x-webhook-secret` header.

## Alert to agent loop

PostHog alert or survey response -> webhook -> `POST /api/hooks/posthog` (header
`x-webhook-secret` = `POSTHOG_WEBHOOK_SECRET`, compared in constant time; empty secret = 401)
-> the redacted item goes to S3 and a `TrackerItemWorkflow`, whose worker activity files it as a
work item in the tracker, Plane by default (`worker/tracker.py`, the same client the support
triage uses; setup in [docs/support.md](support.md#trackers)). Alerts never
create GitHub issues unless an installation switches the whole tracker to `TRACKER=github`.

- `$insight_alert_firing` -> producer `cjm-regression`, title `[cjm] <alert name>`, body with
  the breach text and the insight link; a repeat of the same alert comments on the open item
  with exactly that title (found in the project's Intake or by Plane's work item search).
- `survey sent` from the feedback survey -> producer `from-users`, the answers (personal data
  redacted by the Presidio sidecar when `PII_REDACT_URL` is set, and nothing filed while it is
  down; emails masked otherwise, docs/support.md "Personal data"), page, release and the session
  replay link. The title is cut from the redacted first answer.
- Producers map to labels and to Intake or a target state in `config/tracker.json`. New items
  land in Plane's Intake by default, where a human accepts, declines or snoozes them. Nothing
  here closes an item or moves it to a completed state.
- Thumbs on AI answers (`$ai_trace_id`) and any other event are ignored.
- The endpoint answers `started` (or `duplicate` for a redelivered webhook). Without tracker
  credentials the worker only logs what it would file (dry run).

PostHog's own GitHub destination exists but creates issues from error-tracking exceptions via
a GitHub App, not from alerts or surveys, so the receiver above is the smallest working path.
User feedback text goes to the tracker: self-host Plane where it must stay in place, or leave
the tracker credentials empty and read the responses in PostHog instead.

With the service desk configured ([docs/support.md](support.md)), "report a problem / suggest an
improvement" moves into the Chatwoot widget's Help menu (one entry point for users, works on every
tier including Umami-only) and `journeys:sync` skips the feedback survey. Without it:

Feedback on the Umami-only tier: Umami has no surveys; connect Formbricks for NPS/CSAT
([above](#formbricks-connect-your-own)). GlitchTip implements Sentry's
crash-report dialog (user reports attached to an error), not a standalone "suggest an
improvement" widget, so that tier has no feedback channel yet (docs/TODO.md).

## Rules for coding agents

- Every user-facing feature declares its events in `config/events.json` (name, description,
  props, `pii`) and adds its steps to a journey in `config/journeys.json` when it is part of
  one. `track()` takes a literal name and an object literal of declared props;
  `pnpm check:events` enforces it.
- Never put emails, names, free text or ids from the URL in props. `track()` masks emails and
  UUIDs and keeps only declared props; mark anything that may identify a person `pii: true`.
- Surveys only through the `surveys` block of `config/journeys.json` and `pnpm journeys:sync`,
  each linked to a catalog flag; never hand-made in the PostHog UI, never an own response table.
- Read the product's state before changing a flow: `pnpm journeys:report`, or the PostHog /
  Umami MCP (`.mcp.json.example`). Tracker items labelled `cjm-regression` or `from-users` are
  real user pain: close them from the PR that fixes them (`Fixes PROJ-123`, docs/releases.md).
