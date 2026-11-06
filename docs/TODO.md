# Known limitations / backlog

- **Transactional outbox for workflow starts.** `POST /api/projects` starts the Temporal
  workflow after commit; if Temporal is unreachable at that moment the start is logged and lost
  (`apps/api/src/routes/projects.ts`). Fix: write an outbox row in the same transaction and have a
  small relay start workflows from it (still idempotent via the workflow id).
- **Attachment upload confirmation.** The attachment row is created before the browser uploads
  the bytes, so an abandoned upload leaves a row without an object. Fix: add `uploaded_at`, set it
  from a `POST .../attachments/:id/complete` that HEADs the object, and hide/expire rows without it.
- **osv-scanner ignore for `@opentelemetry/core` 1.x** expires 2027-02-01 (`osv-scanner.toml`).
  Remove it once `@temporalio/interceptors-opentelemetry` depends on OpenTelemetry 2.x.
- **AI content retention is recorded, not enforced.** `ai_calls.content_expires_at` is set from
  `AI_CONTENT_RETENTION_DAYS`, but nothing deletes the S3 objects. Fix: apply an S3 lifecycle
  expiration rule to `AI_CONTENT_BUCKET` at deploy time (or a scheduled Temporal workflow that
  deletes expired objects); keep the rows, which hold no content.
- **AI calls export loads all rows in memory** (`apps/api/src/routes/ai-calls.ts`). Fine for
  thousands of rows; stream with a server-side cursor before orgs reach ~100k calls.
- **`audit_log` is not append-only** for the app role, unlike `ai_calls`. Consider adding it
  to the append-only list in `packages/db/src/migrate.ts` (check nothing updates it first).
- **AI metrics are not emitted yet.** The LLM dashboard and the `AiScoreDrop`/`AiCostSpike`
  alerts (`infra/grafana/dashboards/llm.json`, `infra/otel/alerts.yml`) read `ai_calls_total`,
  `ai_call_latency_seconds`, `ai_cost_usd_total`, `ai_score_avg` (names in AGENTS.md
  "Observability"); nothing produces them, so the panels are empty. Fix: an OTel meter in
  `Gateway.call_llm` (`services/worker-py/worker/ai.py`) plus a MeterProvider next to the
  TracerProvider in `worker/__main__.py`, and the eval job for `ai_score_avg`.
- **Alert notifications.** Prometheus evaluates the rules but nothing routes them. Fix: add
  Alertmanager (Apache-2.0) to the observability profile with a receiver per deployment.
- **Collector reads every container's log file on the host** (filtered to this compose project
  by label). Fine on a dedicated host; on a shared Docker host consider the Docker `fluentd`/OTLP
  log driver per service instead, so other projects' files are never opened.
- **Browser errors are not linked to backend traces.** The web app has no OpenTelemetry, so
  GlitchTip/Sentry browser events carry the SDK's own trace id. Fix if needed: browser OTel with
  `traceparent` on `/api` calls, or tag events with the `trace_id` returned in a response header.
- **`@sentry/node` 11 pulls the FSL-licensed `sentry` CLI** via `@sentry/bundler-plugins`, so the
  API uses `@sentry/node-core` 10. Revisit when a `@sentry/node-core` 11 is published or the CLI
  becomes optional upstream.
- **Temporal server traces are not exported** (only its metrics are scraped); the Temporal SDK
  spans in the API and worker cover workflow/activity timing. Enable the server's OTEL env vars
  if server-side spans are needed.
