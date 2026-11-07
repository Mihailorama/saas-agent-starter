# 0012. Product analytics and user feedback in external tools

Status: accepted (owner decision, 2026-11-06)

## Context

Agent-built products need a feedback loop on the user path, not only on code quality: where a
journey breaks, which step got slow, which AI answers users reject, what they report. Running
our own event journal, funnel math, detectors and feedback store would duplicate mature
open-source tools and give agents and humans a worse UI than those tools have.

## Decision

- No first-party event store. Events, funnels, replay, heatmaps, surveys and alerts live in
  external tools; the repo keeps the contract: `config/events.json` (catalog),
  `config/journeys.json` (journeys as code), one `track()` wrapper, a consent banner
  (vanilla-cookieconsent, MIT; opt-in or opt-out per region, GPC, Google Consent Mode v2) and the
  `pnpm check:events` CI rule ([docs/product-analytics.md](../product-analytics.md)).
- **PostHog Cloud is the default** for every tier and delivery, region (EU or US) by env:
  the most complete open-source product-analytics suite (funnels with threshold alerts, replay,
  heatmaps, surveys, AI observability, MCP), free tier large enough for a starter.
  Rage/dead clicks, web vitals and exceptions come from its autocapture, not our code.
- **Umami 3 (MIT, PostgreSQL only)** is the self-hosted fallback where data must not leave the
  client's servers (on-prem, RU contour under 152-FZ localization): one container on our
  Postgres, measured at ~256 MiB idle / ~780 MiB peak.
- **AI-answer thumbs** go to PostHog AI observability (survey response with `$ai_trace_id`)
  and, when configured, to Langfuse (`@langfuse/browser` score with a public key), both on the
  OpenTelemetry trace id that ADR 0008 already stores per LLM call.
- **GA4 and Yandex Metrika** are optional sinks, consent-gated, off by default and never
  on-prem.
- `pnpm journeys:sync` defines PostHog funnel insights, funnel alerts, surveys and webhook
  destinations, and Umami funnels through their APIs; `--dry-run` prints the plan.
- Alerts and survey responses reach agents as tracker items (`cjm-regression`, `from-users`)
  through one small webhook receiver in the API (shared secret; dry run without credentials),
  because PostHog's GitHub destination only covers error tracking. The tracker is Plane by
  default (Intake), the same one the service desk uses (ADR 0013); GitHub Issues is optional.
- Every sink is optional and env-driven; with no env the app makes no analytics request.

## Alternatives

- Own collector + table + funnel watcher: rejected by the owner; it re-implements a product
  category and still lacks replay/heatmaps.
- Self-hosted PostHog as the default: 4 vCPU / 16 GB minimum, officially unsupported; only on
  a separate client VM.
- Plausible CE: AGPL-3.0 and needs ClickHouse; fewer product features than Umami 3 for this
  use. Matomo: GPL-3.0, MySQL. Both stay documented replacements.
- PostHog's native GitHub destination: tied to error tracking and a GitHub App; does not take
  alerts or survey answers.

## Consequences

- Code dependencies added to the web: `posthog-js` (`Apache-2.0 AND MIT`),
  `@langfuse/browser` (MIT) and `vanilla-cookieconsent` (MIT), all loaded lazily and only when
  configured. Umami runs as an
  unmodified container (MIT), listed in docs/LICENSES.md.
- The CSP gets the enabled sinks' origins from `ANALYTICS_ORIGINS`; empty by default.
- Umami has no alerting: on the Umami tier alerts are meant to come from Grafana (observability
  profile, ADR 0010) with a rule per journey on Umami's database (docs/TODO.md); until that is
  built, a scheduled `pnpm journeys:report`.
- PostHog's alert-webhook creation through hog functions is how its UI works but is not a
  documented API contract; the documented fallback is adding the webhook in the alert UI.
