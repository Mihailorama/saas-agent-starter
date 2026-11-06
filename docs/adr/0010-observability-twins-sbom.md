# 0010. Observability, permissive twins, SBOM, error tracking

Status: accepted

## Context

The owner works in Grafana + Loki, and logs were missing: only traces (Jaeger) and metrics
(Prometheus) were collected. Some enterprise clients ban AGPL (or any non-permissive license)
in on-premises deliveries, even for unmodified separate containers, and ask for an SBOM and a
notices file. Errors had no tracker.

## Decision

**One pipeline, Grafana as the single pane.** The `observability` compose profile runs the
OpenTelemetry Collector (contrib distribution, Apache-2.0), Jaeger (traces), Prometheus
(metrics + alert rules), Loki (logs) and Grafana with provisioned datasources and dashboards
(`infra/grafana/`).

- Logs: every service logs structured JSON to stdout. The json-file log driver stamps each
  line with its compose project and service (`x-logging` in `docker-compose.yml`); the
  collector's `filelog` receiver tails `/var/lib/docker/containers` read-only (as root, which
  that directory requires), keeps only this compose project, lifts `trace_id`/`span_id` into
  the OTLP log record and sends it to Loki's native OTLP endpoint. No Docker logging plugin,
  nothing to install on the host. Containers of other projects on the host are read and
  dropped by the collector's filter.
- Correlation: pino (`mixin` in `app.ts`) and the worker's `JsonFormatter` add the active
  OTel `trace_id`/`span_id`. Loki stores them as structured metadata; Grafana's Loki
  datasource turns `trace_id` into "View trace" (Jaeger) and "Errors for this trace" (the
  error tracker's issue search); Jaeger's datasource links a trace to its logs.
- Metrics: API HTTP metrics (stable semconv) via OTLP; the worker exports the Temporal SDK's
  metrics over OTLP/HTTP through the Temporal Core runtime; Temporal server is scraped.
  Prometheus ingests OTLP natively. Dashboards are JSON in `infra/grafana/dashboards/`.
- LLM dashboard and alerts use the metric names agreed in AGENTS.md (`ai_calls_total`,
  `ai_call_latency_seconds`, `ai_cost_usd_total`, `ai_score_avg`); until the worker emits
  them, those panels are empty.
- Alerts are Prometheus rules (`infra/otel/alerts.yml`), so they work in both twins; Grafana
  shows them. Notifications need Alertmanager, not included.
- Every container has a `mem_limit` sized from a measured `docker stats` snapshot
  (docs/STACK.md).

**Permissive twins by override file, not profiles.** A compose profile can add services but
cannot remove one that runs by default (`redis`), so a literal `--profile permissive` cannot
swap Redis out. `compose.permissive.yaml` overrides the same service names: `redis` runs the
Valkey image (BSD-3-Clause, same protocol, same `REDIS_URL`), Loki and Grafana move to a
profile nobody enables, and the collector drops its Loki pipeline (`collector-logs.yaml` is a
second, optional config file). One command:
`docker compose -f docker-compose.yml -f compose.permissive.yaml up` (or `COMPOSE_FILE` in
`.env`). The application does not change; CI runs the API integration tests against both
stores. The loss per component is in docs/LICENSES.md (replacement map).

**SBOM and notices.** `pnpm run sbom` (`pnpm sbom` is a pnpm 11 built-in for npm-only SBOMs)
builds the app images, pulls every image of every profile in both twins and runs syft
(Apache-2.0, as a container) for one CycloneDX JSON per image, plus `THIRD_PARTY_NOTICES.md`
from the license gate's own inventory (npm, PyPI, crates) and the image table in
docs/LICENSES.md. Output in `dist/sbom/`, uploaded as a CI artifact on `v*` tags. Generated, not
committed: it changes with every dependency bump.

**Error tracking over the Sentry protocol.** The apps use the Sentry SDKs (MIT): `@sentry/react`
(web), `@sentry/node-core` (API), `sentry-sdk` (worker, with a Temporal activity interceptor,
because the SDK catches activity exceptions before anything global sees them). Off unless
`SENTRY_DSN` (web: `VITE_SENTRY_DSN` at build time) is set; release = git sha (`GIT_SHA` build
arg, `SENTRY_RELEASE`). Errors only, no Sentry tracing: traces stay in OpenTelemetry and every
server event carries the OTel `trace_id` as a tag and trace context. PII and content are
scrubbed in `beforeSend` (no request data, user, extra, local variables; SDK 11 data collection
switched off in the browser). Backends, same SDKs, only the DSN changes:

- Tier S: GlitchTip (MIT) in the `glitchtip` profile, all-in-one process, its own database on
  the app's Postgres server and Redis db 1. Its docs: PostgreSQL 14+, Valkey/Redis optional,
  512 MB RAM recommended, 256 MB minimum all-in-one
  ([install docs](https://glitchtip.com/documentation/install)).
- Tier M/L: Sentry, SaaS or self-hosted. Self-hosted is not in our compose: FSL-1.1-Apache-2.0
  ([LICENSE.md](https://github.com/getsentry/self-hosted/blob/master/LICENSE.md)) and minimum
  4 CPU cores, 16 GB RAM + 16 GB swap, 20 GB disk
  ([self-hosted docs](https://develop.sentry.dev/self-hosted/), checked 2026-11-06); its
  installer's `errors-only` profile, which is all we use, accepts 2 cores and 7000 MB
  ([`_min-requirements.sh`](https://github.com/getsentry/self-hosted/blob/master/install/_min-requirements.sh)).

`@sentry/node` 11 is not used: it depends on `@sentry/bundler-plugins` -> `sentry` (the Sentry
CLI, FSL-1.1-Apache-2.0), which the code license gate rejects (ADR 0005), and its Fastify
integration registers a second `@fastify/otel` next to ours, which crashes the API.

## Consequences

- One `docker compose --profile observability up` gives logs, traces, metrics, dashboards and
  alerts; the permissive twin keeps traces, metrics and alert rules, and loses central logs and
  dashboards.
- The collector reads all container log files on the host (filtered to this project). On a
  shared host where that is unacceptable, use the permissive twin or run the stack under its
  own Docker daemon.
- Browser errors carry the Sentry SDK's own trace id, not an OTel one: the web app has no
  OpenTelemetry. Source maps are not uploaded by default; see README "Error tracking".
