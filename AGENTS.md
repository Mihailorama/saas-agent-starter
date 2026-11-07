# AGENTS.md

Single source of rules for coding agents (Claude Code, Codex, others) and humans.
`CLAUDE.md` only imports this file. Keep it accurate when you change the code.

## Definition of done

`pnpm check` is green. It runs, in order: Biome (format + lint), the analytics event check
(`check:events`, `scripts/*.test.mjs`), typecheck with tsrs,
TS unit/integration tests, `cargo fmt/clippy -D warnings/test`, `ruff format/check`,
pyright (strict), pytest, the license gate for all three ecosystems, and the Playwright smoke.
It needs the local infra running (see Setup).

Typecheck: day to day it is tsrs (`pnpm typecheck:fast`, Rust port of the TypeScript checker,
fastest and lightest). Releases are also checked with the official TypeScript 7 compiler (`tsc`,
Go): `pnpm check:release` locally, and CI does it on every `v*` tag. If tsrs and tsc disagree,
tsc wins: fix the code to satisfy tsc and record the case in docs/TODO.md. Do not finish a task with it red, and do not
"fix" it by skipping, deleting or weakening a test, lint rule or license entry.

## Setup

```sh
docker compose up -d --wait postgres redis s3 temporal-ui   # infra only
pnpm i && pnpm db:migrate
pnpm dev        # API :3000 + web :5173 (Vite proxies /api)
pnpm worker     # Python Temporal worker
```

Tools: Node 22.18+ (runs `.ts` directly), pnpm, Docker, uv, Rust (rustup) and
`cargo install --locked cargo-deny`. Config comes from env: real env > `.env` (gitignored,
overrides) > `.env.example` (local defaults, committed, example values only).

## Architecture map

```
apps/api            TypeScript, Fastify. HTTP API, auth, tenancy, starts workflows.
  src/app.ts          plugins, security hooks, auth routes, health, OpenAPI
  src/tenant.ts       requireRole() + withTenant(): RBAC, RLS transaction, audit log
  src/routes/*.ts     one file per resource (Zod schemas + handlers); ai-calls.ts = AI audit log,
                      hooks.ts = PostHog alerts, support.ts = Chatwoot/GitHub/Plane hooks
  src/temporal.ts     Temporal client + workflow contracts with the worker
  src/s3.ts           S3 client, presigned upload/download URLs
  src/telemetry.ts    OpenTelemetry (preloaded, env-toggled)
  test/               integration tests against the real compose services
apps/web            React + Vite, TanStack Router/Query/Table, shadcn/ui, Tailwind
  src/pages/          sign-in, shell (sidebar, org switcher), projects, project detail
  src/components/ui/  shadcn/ui components (copied source; edit freely)
  e2e/                Playwright smoke
packages/db         Drizzle schema, migrations, RLS policies, withOrg(), migrate script
services/worker-py  Python, Temporal workflows + activities (AI/data work goes here)
  worker/ai.py        AI gateway: Gateway.call_llm, model registry, providers (the ONLY LLM caller)
  worker/s3.py        minimal SigV4 S3 client (AI request/response content)
  worker/support.py   service desk triage + tracker adapters (GitHub, Plane), return path
config/             ai-models.json (allowed models per contour/purpose, prices),
                    ai-transparency.json (public /ai-transparency page),
                    events.json (analytics event catalog), journeys.json (journeys as code)
crates/core         Rust hot paths exposed to Python via PyO3 (module `saas_core`)
infra/              Temporal setup, SeaweedFS (dev S3), OTel collector, Prometheus + alert
                    rules (infra/otel), Grafana datasources + dashboards (infra/grafana)
compose.permissive.yaml  permissive-license twin of the stack (docs/LICENSES.md)
scripts/            license-check.mjs (JS + Python + Rust + images), sbom.mjs (`pnpm run sbom`),
                    check-events.mjs, journeys.mjs (sync/report PostHog + Umami funnels)
docs/adr/           why things are the way they are; docs/LICENSES.md for images
docs/ai-act.md      what the AI layer covers for the EU AI Act, and what it does not
docs/support.md     service desk: Chatwoot setup, channels, triage, tracker return path
```

Request path: browser -> web (`/api` same origin) -> Fastify -> `requireRole` (session,
active org, role) -> handler -> `withTenant` (transaction with `app.org_id`, Postgres RLS,
audit row) -> commit -> optional `startProjectCreated` (Temporal) -> Python worker
activity -> Rust `simhash` -> writes back to Postgres under the same RLS scoping.

## Component picks (one line each; details in docs/adr)

- TypeScript + Fastify: mainstream, fast, first-class Zod/OpenAPI and security plugins.
- Zod at every boundary (env, HTTP in/out); OpenAPI generated from the same schemas.
- Postgres + Drizzle: SQL-first ORM with typed schema, migrations and RLS policy support.
- Postgres RLS for tenancy: isolation holds even when application code forgets a filter.
- Better Auth: auth as a library on our own tables (orgs, roles, sessions); Keycloak is the
  heavier alternative when enterprises need a separate IdP.
- Temporal: durable workflows with retries/timeouts, typed SDKs for TS and Python, Web UI.
- Redis (official image, via ioredis): shared rate-limit store across API replicas.
- S3 API via the AWS SDK: works with AWS, R2, MinIO, SeaweedFS (local dev uses SeaweedFS).
- OpenTelemetry: one vendor-neutral standard for traces/metrics in TS, Python and Temporal;
  Collector -> Jaeger/Prometheus/Loki, Grafana as the single pane (ADR 0010).
- Sentry protocol for errors: Sentry SDKs (MIT) in web/API/worker; GlitchTip (MIT) locally,
  Sentry SaaS/self-hosted for bigger installs. Only the DSN differs.
- React + Vite + TanStack + shadcn/ui: no framework lock-in, static build, owned components.
- Python worker: where the AI/data ecosystem lives. Rust via PyO3 only for measured hot paths.
- Biome, Vitest, Playwright, ruff, pyright, pytest, clippy: one fast tool per job.
- PostHog Cloud for product analytics, replay, surveys, AI feedback; Umami (MIT) self-hosted
  where data must stay in place (ADR 0012).
- TypeScript 7 (official Go compiler) + tsrs (Apache-2.0, Rust port, beta): tsrs for everyday
  checks, tsc on releases as the authoritative check (ADR 0011).
- Chatwoot CE (MIT, `-ce` image only) as the service desk; backlog items in GitHub Issues or
  Plane Intake; triage is a Temporal workflow in the worker, no own ticket table (ADR 0013).

## Where code goes (TS vs Python vs Rust)

- HTTP API, auth, tenancy, web UI: TypeScript.
- AI/LLM calls, data processing, long-running or retryable work: Python activities in
  `services/worker-py`, orchestrated by Temporal workflows.
- Rust only for a hot path you have measured in Python. It must keep a pure-Python twin and
  a parity test (see `worker/text.py`, `tests/test_text.py`) and come with a benchmark.

## Recipe: add a tenant resource (example: `projects`)

1. Schema: add the table in `packages/db/src/schema.ts` with `orgId: orgId()` and
   `tenantIsolation()` in the table extras. Run `pnpm db:generate`, review the SQL
   (it must contain `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY "tenant_isolation"`),
   then `pnpm db:migrate`.
2. RLS test: extend `packages/db/test/rls.test.ts` only if the table has special rules;
   the generic policy is already proven there.
3. Route: copy `apps/api/src/routes/projects.ts`. Every handler has
   `preHandler: requireRole(...)` and does all DB work inside `withTenant(req, tx => ...)`.
   Validate `params`/`body`/`response` with Zod. Register it in `src/app.ts`.
4. Tests: add integration tests in `apps/api/test/` covering success, 400, 401/403 and
   cross-tenant 404.
5. Web: add a page in `apps/web/src/pages/`, a route in `src/main.tsx`, a nav link in
   `pages/shell.tsx`. Use TanStack Query for data and shadcn/ui components.
6. `pnpm check`.

A Claude Code command with the same steps: `/add-resource <name>`.

## Recipe: add a background workflow

1. Python: in `services/worker-py/worker/`, add `@activity.defn` methods (idempotent:
   check-then-write in one transaction, `set_config('app.org_id', ...)` before tenant
   queries) and a `@workflow.defn(name="...")` class with explicit timeouts and a
   `RetryPolicy`. Register both in `worker/__main__.py`.
2. TS: add a typed starter next to `startProjectCreated` in `apps/api/src/temporal.ts`.
   Use a deterministic workflow id derived from the entity id plus
   `workflowIdReusePolicy: 'REJECT_DUPLICATE'` so retries never run it twice.
   Start it after the DB transaction commits.
3. Tests: a pytest in `tests/test_workflow.py` style (real Temporal, unique task queue)
   that checks the end result and that a duplicate start is rejected.
4. The argument dataclass in Python and the TS type are the contract; change both together.

## Recipe: add an AI purpose (example: `project.summary`)

1. Registry: add the purpose to the allowed models in `config/ai-models.json` for every
   contour that should offer it (with `pricePer1kTokens`, or `null` if unknown). Add a `uses`
   entry with the same `purpose` to `config/ai-transparency.json`.
2. Activity: in `services/worker-py/worker/activities.py`, call `self.ai.call_llm(...)` with
   the purpose, an explicit `model` and `provider` (from a per-purpose env setting such as
   `AI_PROJECT_SUMMARY_MODEL`; unset = feature off, never a fallback), the org and actor ids,
   a prompt template id + version (bump the version whenever the prompt text changes) and
   `max_tokens`. Read user content from the DB inside the activity; pass ids, not content,
   through workflow arguments.
3. Oversight: if the output is stored and shown, store it with `ai_status='generated'` and
   `ai_call_id`, add confirm/correct endpoints like `projects.ts` and show `<AiBadge>` in the
   web next to it.
4. Tests: a pytest with a fake provider (see `tests/test_ai.py`) that checks the stored result
   and the `ai_calls` row; API tests for the review endpoints.
5. Write the AI system card (template in `docs/ai-act.md`). `pnpm check`.

## Conventions

- Small files, colocated by feature. No speculative abstractions or empty folders.
- TypeScript strict, ESM, `.ts` import extensions on the server. Python 3.12, typed, strict
  pyright. Rust edition 2024, clippy clean.
- Errors: throw `httpError(status, msg)` in handlers; never leak internals in responses.
- Logs are structured JSON (pino / Python logging). Log ids, not payloads. See Observability.

## Observability

Run it: `docker compose --profile observability up -d` with `API_OTEL_ENDPOINT` and
`WORKER_OTEL_ENDPOINT` set to `http://otel-collector:4318` (Grafana :3001). Design: ADR 0010.

Logging rules:

- One JSON object per line on stdout/stderr: pino in the API (`app.log`/`req.log`), the
  `logging` module in the worker (`worker/log.py` formats it). No `console.log`/`print`.
- `trace_id`/`span_id` are added automatically inside a span; do not add them by hand, and do
  not log outside the request/activity when you can log inside it.
- Never log secrets, tokens, cookies, headers, request/response bodies, query strings, prompt
  or completion content, or personal data. Log ids (org, project, ai call, workflow) and
  counts. The same goes for span attributes and metric labels (labels: low cardinality only,
  never ids of users or content).
- Errors: report through the Sentry SDK only (it is already initialised; the API reports 5xx
  from its `onError` hook, the worker every failed activity). Do not hand-roll error
  reporting, error webhooks or "error" tables. Log the error too (with ids), but never put
  content in the exception message.

Metric names agreed for the AI layer (dashboard `LLM`, alert `AiScoreDrop`), emitted by the
worker over OTLP: `ai_calls_total` (counter; labels `purpose`, `model`, `provider`, `status`),
`ai_call_latency_seconds` (histogram; `purpose`, `model`), `ai_cost_usd_total` (counter;
`purpose`, `model`), `ai_score_avg` (gauge, 0..1; `purpose`). Keep these names and labels.

Add a dashboard: build it in Grafana (anonymous admin in local dev), Export -> "Export as
JSON" with "Export for sharing externally" off, set a stable `uid`, use datasource uid
`prometheus`/`loki`/`jaeger`, save it as `infra/grafana/dashboards/<uid>.json`. Use
`$__rate_interval` in `rate()` (SDKs push every 60s). Restart Grafana to load it.

Add an alert: a Prometheus rule in `infra/otel/alerts.yml` (works without Grafana), with
`for:`, a `severity` label and a `summary`. Check it with
`docker compose exec prometheus promtool check rules /etc/prometheus/alerts.yml`.

New infrastructure container: list it with its license in docs/LICENSES.md (the gate fails
otherwise); if it is not permissive, give it a twin in `compose.permissive.yaml` and a row in
the replacement map.

## AI rules

- All LLM calls go through `Gateway.call_llm` (`services/worker-py/worker/ai.py`). Never call
  a provider SDK or HTTP API directly, and never call an LLM from the TypeScript API or web.
- The model is always explicit: no default model in code, config or function signatures. A
  model that is not in `config/ai-models.json` for the current `AI_CONTOUR` is refused.
- Never put prompt or completion content in logs, span attributes, exceptions, audit rows or
  Temporal workflow arguments. It lives only in the `ai_calls` S3 objects.
- `ai_calls` is append-only: never grant UPDATE/DELETE on it or "fix" rows; record a new event.

## Product analytics rules

Details: docs/product-analytics.md, ADR 0012.

- Every user-facing feature declares its events in `config/events.json` (name, description,
  props, `pii`) and, if it is part of a customer journey, its steps in `config/journeys.json`.
  Emit them only with `track('<literal name>', { declared props })` from
  `apps/web/src/lib/analytics.ts`; `pnpm check:events` fails otherwise.
- Never send free text, emails, names or URL ids as props; mark identifying events `pii: true`.
- No own event tables, collectors, funnel jobs or click detectors: analytics, funnels, replay,
  heatmaps, surveys and alerts live in PostHog (default) or Umami (self-hosted fallback).
- Before changing a flow, read its state: `pnpm journeys:report`, or the PostHog / Umami MCP
  (`.mcp.json.example`). After changing journeys, `pnpm journeys:sync --dry-run` shows what
  would change in the tools. Issues labelled `cjm-regression` or `from-users` come from real
  users: link them in the PR that fixes them.

## Security rules

- Tenant tables: always `orgId()` + `tenantIsolation()`, always accessed via `withTenant`
  (API) or a transaction that sets `app.org_id` (worker). Never query them with the
  migration/owner role. The API refuses to start if its DB role can bypass RLS.
- Never log secrets, tokens, cookies or request bodies; the logger redacts common paths
  and drops query strings.
- Validate all input with Zod/dataclasses; never build SQL with string concatenation.
- New dependencies must pass `pnpm check:licenses` (allowlist in `scripts/license-check.mjs` and
  `deny.toml`): permissive licenses plus MPL-2.0 (file-level copyleft, no obligations on our
  code while unmodified). GPL/LGPL/AGPL/EUPL/SSPL/BUSL and other copyleft or source-available
  licenses stay banned for code dependencies (infrastructure containers are separate, see
  docs/LICENSES.md). Never add an exception to make the gate pass; ask a human
  (docs/adr/0005-license-policy.md).
- We never modify dependency files: no `pnpm patch`/`patch-package`, no edits in
  `node_modules`/`.venv`/vendored copies, no forks swapped in for the upstream package. Fixes
  go upstream (issue or PR); until a release lands, work around it in our own code.
- No real secrets, client names or private data in the repo, ever. Example values use
  `example.com` and `local-dev-*`.

## Never

- Bypass or disable RLS, run the app as the DB owner/superuser, or add `BYPASSRLS`.
- Commit `.env`, credentials, media/binary files, or generated `dist/`, `target/`, `.venv/`.
- Add Next.js/Vercel-specific code, or GPL/LGPL/AGPL/SSPL/BSL code dependencies (infra
  containers run unmodified are exempt, see docs/LICENSES.md).
- Patch, fork-in-place or edit a dependency's files (fixes go upstream).
- Push to `main` without `pnpm check` green, or force-push.
