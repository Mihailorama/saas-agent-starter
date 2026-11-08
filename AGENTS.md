# AGENTS.md

Single source of rules for coding agents (Claude Code, Codex, others) and humans.
`CLAUDE.md` only imports this file. Keep it accurate when you change the code.

## Definition of done

`pnpm check` is green. It runs, in order: Biome (format + lint), the generated web API types
check (`check:api-types`; after changing a route schema run `pnpm api:types`), the analytics event check
(`check:events`), the feature-flag check (`check:flags`), `scripts/*.test.mjs`, typecheck with tsrs,
TS unit/integration tests, `cargo fmt/clippy -D warnings/test`, `ruff format/check`,
pyright (strict), pytest, the license gate for all three ecosystems, the key-free eval
(`pnpm eval --fake-llm`, needs Docker) and the Playwright smoke.
It needs the local infra running (see Setup).

Typecheck: day to day it is tsrs (`pnpm typecheck:fast`, Rust port of the TypeScript checker,
fastest and lightest). Releases are also checked with the official TypeScript 7 compiler (`tsc`,
Go): `pnpm check:release` locally, and CI does it on every `v*` tag. If tsrs and tsc disagree,
tsc wins: fix the code to satisfy tsc and record the case in docs/TODO.md. Do not finish a task with it red, and do not
"fix" it by skipping, deleting or weakening a test, lint rule or license entry.

## Setup

```sh
docker compose up -d --wait postgres redis s3 temporal-ui mailpit   # infra only
docker compose --profile billing up -d stripe-mock                  # Stripe API mock (API tests)
docker compose --profile mcp up -d mcp-server                       # reference MCP server (worker tests)
pnpm i && pnpm db:migrate
pnpm dev        # API :3000 + web :5173 (Vite proxies /api)
pnpm worker     # Python Temporal worker (also delivers mail; Mailpit UI :8025)
```

`pnpm check` needs the worker running: the auth tests read the mails it sends from Mailpit.
CI runs it with `TEMPORAL_TASK_QUEUE` pointed elsewhere, so only the `email` queue is served
and the API tests' project workflows stay untouched.

Tools: Node 22.18+ (runs `.ts` directly), pnpm, Docker, uv, Rust (rustup) and
`cargo install --locked cargo-deny`. Config comes from env: real env > `.env` (gitignored,
overrides) > `.env.example` (local defaults, committed, example values only).

## Architecture map

```
apps/api            TypeScript, Fastify. HTTP API, auth, tenancy, starts workflows.
  src/app.ts          plugins, security hooks, auth routes, health, OpenAPI
  src/auth.ts         Better Auth: orgs, OIDC, 2FA (TOTP), passkey and API key plugins
  src/signup-guard.ts disposable / allow / deny email domains on every address write (docs/security.md)
  src/mfa.ts          re-auth, audit_log rows, TOTP replay guard, org 2FA policy on org endpoints (ADR 0017)
  src/tenant.ts       requireRole() / access(scope) + withTenant(): RBAC, org 2FA policy, API key
                      scopes, RLS transaction, audit log, webhook events started after commit
  src/access.ts       org roles (Better Auth AC) + organization API key plugin config + the
                      admin plugin's platform roles (user, operator)
  src/operator-guard.ts operator list (OPERATOR_EMAILS), read-only "view as user" sessions and
                      suspended orgs on Better Auth's endpoints (docs/admin.md)
  src/events.ts       publishEvent(): the one path for webhook events (docs/public-api.md)
  src/routes/*.ts     one file per resource (Zod schemas + handlers); ai-calls.ts = AI audit log,
                      hooks.ts = PostHog alerts (-> S3 + TrackerItemWorkflow) + CRM signals,
                      support.ts = Chatwoot/Plane/GitHub hooks, crm.ts = booking hook (Cal.diy),
                      admin*.ts = operator console (requireOperator; the only withOperatorRead callers)
                      privacy.ts = data export/deletion requests (docs/privacy.md),
                      mcp-servers.ts = the org's external MCP servers (docs/mcp.md),
                      mcp.ts = MCP server at /mcp for API keys; tools call the REST routes (docs/mcp.md),
                      onboarding.ts = checklist item ids + conditions, GET /api/onboarding (docs/onboarding.md)
  src/eval-pull.ts    `pnpm eval:pull`: logged calls (ai_calls + S3) -> Promptfoo test cases
  src/billing/        plans config (any pricing model), entitlements() + requireEntitlement,
                      payment providers (Stripe, manual contracts) behind one interface with
                      capabilities() (docs/billing.md)
  src/temporal.ts     Temporal client + workflow contracts with the worker
  src/email.ts        transactional mail templates (EN/RU, React Email renderer), docs/email.md
  src/s3.ts           S3 client, presigned upload/download URLs
  src/telemetry.ts    OpenTelemetry (preloaded, env-toggled)
  src/flags.ts        isEnabled(): feature flags (PostHog or catalog default)
  test/               integration tests against the real compose services
apps/web            React + Vite, TanStack Router/Query/Table, shadcn/ui, Tailwind
  src/pages/          sign-in, shell (sidebar, org switcher), projects, project detail,
                      admin*.tsx = operator console at /admin (docs/admin.md)
  src/components/ui/  shadcn/ui components (copied source; edit freely)
  src/components/patterns/  app shell, page header, data table, states, confirm dialog,
                      settings section, command palette (docs/ui.md)
  src/components/onboarding-checklist.tsx, src/lib/onboarding.ts  setup checklist card and
                      product tour (driver.js, tours as data on `data-tour`), docs/onboarding.md
  src/dev/            UI gallery + reference screens at /dev/ui (dev builds only)
  e2e/                Playwright smoke, axe a11y on every page; visual.spec.ts (own config)
apps/site           Astro static marketing site + blog (docs/marketing.md): reuses web's index.css
                    and analytics.ts; SEO head in src/components/Seo.astro, posts in src/content/blog
packages/db         Drizzle schema, migrations, RLS policies, withOrg(), withOperatorRead(), migrate script
services/worker-py  Python, Temporal workflows + activities (AI/data work goes here)
  worker/ai.py        AI gateway: Gateway.call_llm, model registry, BYO routing, fallback (the ONLY LLM caller)
  worker/providers.py providers via LiteLLM (every kind), prices from LiteLLM's cost map, BYO SSRF pin
  worker/mcp.py       the org's MCP servers as tools for the gateway's tool loop (docs/mcp.md)
  worker/prompts.py   versioned prompt loader (prompts/<purpose>/<name>.v<N>.md)
  worker/posthog.py   each LLM call as a PostHog `$ai_generation` (when POSTHOG_* is set)
  worker/s3.py        S3 via the MinIO SDK (AI request/response content)
  worker/webhooks.py  webhook delivery: Standard Webhooks signing, SSRF guard, attempt log,
                      secret decryption, auto-disable, retention (daily Temporal Schedule)
  worker/support.py   service desk triage, return path
  worker/tracker.py   the one tracker client (Plane SDK default, GitHub optional): alerts,
                      feedback, triage items; worker/released.py = release comments
  worker/crm.py       CRM sync (Twenty REST behind the `Crm` protocol), one workflow per source event
  worker/flags.py     is_enabled(): feature flags, twin of apps/api/src/flags.ts (posthog SDK)
  worker/pii.py       redact(): Presidio PII redaction; `python -m worker.pii` = API sidecar
  worker/mail.py      SMTP delivery activity for SendEmailWorkflow (smtplib, SMTP_URL)
  worker/billing.py   LLM spend limit, provider events -> subscriptions
  worker/privacy.py   data export/deletion in DB, S3 and each tool (PostHog, Langfuse, Chatwoot,
                      GA4), retention of AI content/exports (daily Temporal Schedule), ADR 0022
config/             ai-models.json (providers, allowed models per contour/purpose, price overrides),
                    plans.json (plans, limits, priced components per currency, billing
                    contours; plans.examples.json: one plan per pricing model),
                    ai-transparency.json (public /ai-transparency page),
                    events.json (analytics event catalog), journeys.json (journeys as code),
                    flags.json (feature flag catalog),
                    webhook-events.json (outbound webhook event catalog),
                    crm.json (deal stages, product signals; `pnpm crm:sync`)
prompts/            prompt templates, one immutable file per version; lock.json pins hashes
evals/              Promptfoo golden sets per purpose (`pnpm eval`, scripts/eval.mjs)
services/llm-cli    vendor CLI subscriptions (claude, codex, gemini, ...) as an internal
                    OpenAI-compatible endpoint; per-subscription limits, queue, round-robin
crates/core         Rust hot paths exposed to Python via PyO3 (module `saas_core`)
infra/              Temporal setup, SeaweedFS (dev S3), OTel collector, Prometheus + alert
                    rules (infra/otel), Grafana datasources + dashboards (infra/grafana),
                    ClickHouse tuning for Langfuse (infra/langfuse)
compose.permissive.yaml  permissive-license twin of the stack (docs/LICENSES.md)
compose.prod.yaml   production stack: images by digest, one-shot migrate, Caddy (docs/deploy.md)
deploy/             Caddyfile, env/<env>.enc.env (SOPS + age), rehearsal.sh (local prod rehearsal)
compose.backup.yaml      backups overlay: pgBackRest, object copy, restore check (docs/backups.md)
infra/backup/       Postgres image (+ pgvector) and backup image (+ pgBackRest/rclone), scripts (ADR 0015)
infra/chatwoot/     Chatwoot initializer: attachments served through Chatwoot (docs/support.md)
infra/caldiy/       build.sh + scan.sh: Cal.diy image from a pinned upstream commit (`booking` profile)
scripts/            license-check.mjs (JS + Python + Rust + images), sbom.mjs (`pnpm run sbom`),
                    check-events.mjs, journeys.mjs (sync/report PostHog + Umami funnels),
                    crm.mjs (`pnpm crm:sync`: Twenty fields, PostHog signal destinations),
                    backup.mjs (`pnpm run backup:now` / `restore`), backup-e2e.sh (CI job),
                    deploy.mjs (`pnpm run deploy -- <env>`), check-migrations.mjs (expand/contract),
                    check-flags.mjs, flags.mjs (flags:sync),
                    eval.mjs (`pnpm eval`), langfuse-publish-prompts.mjs, llmops-evaluators.mjs
docs/adr/           why things are the way they are; docs/LICENSES.md for images
docs/ai-act.md      what the AI layer covers for the EU AI Act, and what it does not
docs/support.md     service desk: Chatwoot setup, channels, triage, tracker return path
docs/crm.md         CRM (Twenty) and booking (Cal.diy): install or connect, sync flows, mapping
docs/admin.md       operator console: who is an operator, actions, audit, impersonation
docs/privacy.md     data map, export/deletion flows, per-tool support matrix, retention
docs/onboarding.md  setup checklist (item ids for rewards rules) and product tour: add a step or item
docs/mcp.md         external MCP tools: connect a server, the reference server, the tool loop
docs/STACK.md       measured memory of the stack, Lite vs Full LLM-ops
docs/security.md    sign-up protection (disposable email), bot-check follow-up
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
  heavier alternative when enterprises need a separate IdP. 2FA/passkeys via its plugins (ADR 0017).
- Temporal: durable workflows with retries/timeouts, typed SDKs for TS and Python, Web UI.
- Redis (official image, via ioredis): shared rate-limit store across API replicas.
- S3 API via the AWS SDK (API) and the MinIO SDK (worker): works with AWS, R2, MinIO, SeaweedFS
  (local dev uses SeaweedFS).
- OpenTelemetry: one vendor-neutral standard for traces/metrics in TS, Python and Temporal;
  Collector -> Jaeger/Prometheus/Loki, Grafana as the single pane (ADR 0010).
- Sentry protocol for errors: Sentry SDKs (MIT) in web/API/worker; GlitchTip (MIT) locally,
  Sentry SaaS/self-hosted for bigger installs. Only the DSN differs.
- React + Vite + TanStack + shadcn/ui: no framework lock-in, static build, owned components.
- UI kit: shadcn/ui via its CLI + our patterns and a dev-only `/dev/ui` gallery (Storybook and
  Ladle fail the license gate); axe, visual regression, Lighthouse, impeccable in CI (ADR 0023).
- Python worker: where the AI/data ecosystem lives. Rust via PyO3 only for measured hot paths.
- LiteLLM SDK as the one path to model providers; vendor CLI subscriptions (default mode) in a
  separate llm-cli container; vLLM for multi-user self-hosting, Ollama for dev (ADR 0024,
  docs/llm-providers.md).
- Biome, Vitest, Playwright, ruff, pyright, pytest, clippy: one fast tool per job.
- Transactional mail: React Email's renderer in the API, delivery by a Temporal activity
  with stdlib `smtplib` over one `SMTP_URL` (any provider), Mailpit in dev (ADR 0014).
- PostHog Cloud for product analytics, replay, surveys, AI feedback; Umami (MIT) self-hosted
  where data must stay in place (ADR 0012).
- Deploy: images by digest + `compose.prod.yaml` + Caddy (auto TLS) + SOPS/age env files, run
  with compose over SSH; Coolify/Kubernetes/on-prem are options on the same core (ADR 0016).
- Public API: organization API keys via `@better-auth/api-key` (same auth library), webhooks as
  a Temporal workflow per event signed per Standard Webhooks; self-hosted Svix lacks the
  customer portal (ADR 0018, docs/public-api.md).
- PostHog feature flags for gradual rollouts (posthog-js/-node/Python), catalog in the repo, no
  own flag store; release-please + Conventional PR titles for changelogs and `v*` tags (ADR 0020).
- Astro (static) for the public site and blog; Postiz (social posting) and SerpBear (rank
  tracking) as unmodified containers in the `marketing` profile; Search Console, IndexNow and the
  GEO check are small scripts, no SDKs (ADR 0021).
- TypeScript 7 (official Go compiler) + tsrs (Apache-2.0, Rust port, beta): tsrs for everyday
  checks, tsc on releases as the authoritative check (ADR 0011).
- Chatwoot CE (MIT, `-ce` image only) as the service desk; backlog items, alerts and feedback in
  Plane (Intake, official Python SDK `plane-sdk`), GitHub Issues (plain REST) optional, one
  tracker client in the worker; triage is a Temporal workflow, no own ticket table (ADR 0013).
- External tools: remote MCP servers per organization through the official `mcp` SDK
  (Streamable HTTP, via LiteLLM's `mcp` extra), a bounded opt-in tool loop in the gateway; the
  `mcp` profile runs the reference `server-everything` for dev/tests (ADR 0028, docs/mcp.md).
- MCP server: official TypeScript SDK v2 (`@modelcontextprotocol/server`, Apache-2.0), Streamable
  HTTP at `/mcp`, stateless, organization API keys as bearer; tools wrap the REST routes (ADR 0027).
- Web API types generated from the API's OpenAPI document (`openapi-typescript`), calls through
  `openapi-fetch`; no hand-written response types (`apps/web/src/lib/api.ts`).
- Twenty (AGPL-3.0 + app exception, unmodified container, `crm` profile) for customer records;
  booking on self-hosted Cal.diy (MIT, `booking` profile, image built by CI from a pinned upstream
  commit; Cal.com Cloud connects the same way). Sync is one Temporal workflow per source event,
  cross-links in Twenty custom fields, no own CRM tables (ADR 0026).

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
5. Web: add a page in `apps/web/src/pages/`, a route in `src/main.tsx` (with
   `staticData.crumbs`), a nav item in `pages/shell.tsx`. Start from the matching reference
   screen (docs/ui.md); TanStack Query for data, catalog components only (UI rules below).
6. Privacy: if rows can hold personal data, add the table to the export and the deletion in
   `services/worker-py/worker/privacy.py` and its decision to the data map in docs/privacy.md.
7. `pnpm check`.

A Claude Code command with the same steps: `/add-resource <name>`.
Before building a product at all: `/validate-idea <idea>` (opt-in founder-skill plugin, real-signal plan; docs/validate-idea.md).

Schema changes are expand/contract (docs/deploy.md "Schema changes"): the previous release
must keep working on the new schema. Drops, renames, type changes and new NOT NULL columns
without a default go into a later release's migration marked `-- contract: <reason>`;
`pnpm check:migrations` enforces it. Never weaken the check to pass it.

## Recipe: expose a route to API keys / add a webhook event

- Route: use `...access('<resource>:<action>')` (tenant.ts) instead of `{ preHandler:
  requireRole(...) }`; add a new scope to `SCOPES` with the role it equals and to the table in
  docs/public-api.md. Test it with a key (`apps/api/test/public-api.test.ts`).
- Event: add the type to `config/webhook-events.json`, then call
  `await publishEvent(req, tx, '<type>', dto)` inside the `withTenant` transaction of the change.
  Never start deliveries yourself. Payload changes follow the versioning rule in
  docs/public-api.md.

## Recipe: expose a tool over MCP

Details: docs/mcp.md, ADR 0027. A tool is a REST route that already accepts API keys
(`access('<scope>')`); never put logic, queries or authorization in the tool itself.

1. In `apps/api/src/routes/mcp.ts`, inside the `scopes.has('<scope>')` block of the route's scope,
   `mcp.registerTool('<verb>_<noun>', { description, inputSchema, outputSchema, annotations },
   (input) => rest(req, '<tool>', '<METHOD>', '<url>', input))`. Reuse the route's exported Zod
   schemas (an array result is wrapped as `{ <noun>s: [...] }`, see `rest`); mark reads
   `readOnlyHint: true`.
2. Test in `apps/api/test/mcp.test.ts`: listed only with the scope, a call that works, and a
   cross-org id that comes back "Not Found".
3. Add the tool to the table in docs/mcp.md.

## Recipe: add an onboarding checklist item or tour step

Details: docs/onboarding.md. Item: add the id and its minimum role to `ONBOARDING_ITEMS` and its
condition (existing data only, no new table) in `apps/api/src/routes/onboarding.ts`, its copy and
action in `ITEMS` of `apps/web/src/components/onboarding-checklist.tsx`, a case in
`apps/api/test/onboarding.test.ts` and a row in docs/onboarding.md; never rename an id. Tour step:
put `data-tour="<id>"` on the element and add the step to `TOUR` in `apps/web/src/lib/onboarding.ts`.

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
   contour that should offer it (with `pricePer1kTokens`; `null` only together with
   `"unmetered": true`, otherwise the gateway refuses the model). Add a `uses`
   entry with the same `purpose` to `config/ai-transparency.json`.
2. Prompt: write `prompts/<purpose>/<name>.v1.md` and add its hash to `prompts/lock.json`
   (the failing test prints the line). Activity: in `services/worker-py/worker/activities.py`,
   `prompt = prompts.load("<purpose>/<name>", 1)` and call `self.ai.call_llm(...)` with
   the purpose, an explicit `model` and `provider` (from a per-purpose env setting such as
   `AI_PROJECT_SUMMARY_MODEL`; unset = feature off, never a fallback), the org and actor ids,
   `prompt_template_id=prompt.id`, `prompt_template_version=prompt.version` and
   `max_tokens` (plus `mcp_tools=True` if the model may call the org's MCP tools, docs/mcp.md). Read user content from the DB inside the activity; pass ids, not content,
   through workflow arguments.
3. Oversight: if the output is stored and shown, store it with `ai_status='generated'` and
   `ai_call_id`, add confirm/correct endpoints like `projects.ts` and show `<AiBadge>` in the
   web next to it.
4. Tests: a pytest with a fake provider (see `tests/test_ai.py`) that checks the stored result
   and the `ai_calls` row; API tests for the review endpoints. Expose the call's trace id
   (`aiTraceId`, like `projects.ts`) so the AI-answer thumbs attach to the generation
   (`aiFeedback()` in `apps/web/src/lib/analytics.ts`).
5. Eval: `evals/<purpose>/promptfooconfig.json` + `dataset.jsonl` (copy `project.summary`) and
   a judge prompt `prompts/judge/<purpose>.v1.md` (`{{input}}`, `{{output}}`, JSON answer with
   `score` 0..1). `tests/test_prompts.py` fails if a prompted purpose has no eval. For online
   quality, add an evaluator for the purpose in PostHog or Langfuse (ADR 0009, "Online
   evaluators"); there is no in-house judge job.
6. Write the AI system card (template in `docs/ai-act.md`). `pnpm check`.

## Recipe: add a prompt version

A prompt is code: reviewed, tested, evaluated. Never edit a released `.v<N>.md`.

1. Copy `prompts/<purpose>/<name>.v<N>.md` to `.v<N+1>.md` and change it. Run `pnpm format`
   (Biome also formats Markdown), then add its hash to `prompts/lock.json` (the failing
   `tests/test_prompts.py` prints the line).
2. Point the eval at it (`gate.prompt.version` in `evals/<purpose>/promptfooconfig.json`) and
   run `pnpm eval:real` on your machine. It runs the model the eval config names
   (`<provider>:<model>` of config/ai-models.json; a CLI subscription runs the logged-in CLI) and
   the judge `claude_cli:claude-opus-5-5` through your Claude subscription (model always
   explicit); no API key in CI. It must pass `gate.minScore`; put the result and the previous
   version's score in the PR description. CI runs only the key-free `pnpm eval --fake-llm`.
3. Switch the code to the new version (e.g. `SUMMARY_PROMPT` in `activities.py`). Every call
   carries the version (`ai_calls`, `ai_prompt_version` in PostHog), so compare versions there
   after deploy.
4. With the Full profile, `pnpm langfuse:prompts` publishes it to Langfuse (label `v<N+1>`).

## Recipe: add eval cases

1. Synthetic: append a line to `evals/<purpose>/dataset.jsonl`:
   `{"description": "...", "vars": {"input": "<exact user message>", "recorded_output": "<a good answer>"}}`.
   No real customer data, names or secrets.
2. From production: `pnpm eval:pull --org <orgId> --purpose <purpose> [--call <id>]...
   [--days 7] [--limit 20]` reads logged calls (ai_calls + S3 content; every export is
   audit-logged) and appends them to `evals/<purpose>/pulled.jsonl` (gitignored). Pick call ids
   from the AI calls page or from low-scored traces in PostHog/Langfuse. Rewrite each case so
   it contains no personal or customer data, then move it to `dataset.jsonl`.
3. Case-specific checks go into the line's own `assert` list (Promptfoo syntax); shared ones
   into `defaultTest.assert`. `pnpm eval` and `pnpm eval:real` must pass.

## Where quality data lives (PostHog or Langfuse)

No own analytics or score tables (owner rule). `ai_calls` is the EU AI Act audit record, not
analytics. Quality data (generations, user feedback, LLM-as-a-judge scores) goes to:

- **PostHog Cloud** (default): the worker sends every call as a `$ai_generation` when
  `POSTHOG_KEY` and `POSTHOG_HOST` (EU or US) are set; the web uses `VITE_POSTHOG_*` (ADR
  0012). The owner creates the accounts; never sign up for one yourself.
- **Langfuse self-hosted** (`--profile llmops`) when a client or the RU contour forbids sending
  data out. About 1.9 GiB RAM plus a ClickHouse (docs/STACK.md).

Both can run at once. Online evaluators (LLM-as-a-judge, drift) live in the tool and are
defined as code by `pnpm llmops:evaluators` (ADR 0009). Do not add score tables, judge
workflows or a second feedback path; user feedback goes through `aiFeedback()` (ADR 0012).

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

Metric names agreed for the AI layer (dashboard `LLM`, alerts `AiErrorRate`, `AiCostSpike`),
emitted by the worker over OTLP (`worker/ai.py`): `ai_calls_total` (counter; labels `purpose`,
`model`, `provider`, `status`), `ai_call_latency_seconds` (histogram; `purpose`, `model`),
`ai_cost_usd_total` (counter; `purpose`, `model`). Keep these names and labels. Quality scores
are not Prometheus metrics: they live in PostHog or Langfuse (ADR 0009).

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
- A new provider is a `providers` entry in `config/ai-models.json` (LiteLLM prefix + env names)
  or a CLI in the llm-cli config, not new gateway code (docs/llm-providers.md). Never pass a key
  implicitly, never log CLI output, never bake logins into an image.
- Never put prompt or completion content in logs, span attributes, exceptions, audit rows or
  Temporal workflow arguments. It lives only in the `ai_calls` S3 objects.
- `ai_calls` is append-only: never grant UPDATE/DELETE on it or "fix" rows; record a new event.
- Prompts live only in `prompts/` (never inline strings in code) and are loaded with an explicit
  version. A prompt change is a new version file with a passing eval (recipe above).
- No LLM API key in CI or in scripts. Real-model evals run locally through the Claude
  subscription (`pnpm eval:real`); `pnpm check` and CI stay key-free (`pnpm eval --fake-llm`).
- Tools: a purpose offers the organization's MCP tools only by passing `mcp_tools=True` to
  `call_llm` (flag `mcp-tools`), and only servers that list that purpose. Never call an MCP server or another tool outside the gateway's
  loop, never offer a tool that is not in the server's `allowed_tools`, never connect to a server
  URL without the SSRF pin (worker/mcp.py), and never put tool arguments or results anywhere but
  the tool call's `ai_calls` S3 objects. No stdio servers.
- PostHog privacy mode stays on (`POSTHOG_PRIVACY_MODE=true`) unless the DPA and the users'
  information allow sending prompt and output text to PostHog.

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

## Backup rules

Details: docs/backups.md, ADR 0015.

- New data store: put it on the existing Postgres server (covered automatically) or an S3
  bucket listed in `BACKUP_APP_BUCKETS`; anything else needs its own backup and a line in the
  "Not backed up" list of docs/backups.md.
- Never write backup state to the database: status is metrics (Pushgateway) and logs.
- Restores go to the `postgres-restore` copy; only `--in-place --yes-overwrite-live` touches
  the live database. Do not use unlogged tables for data that must survive a restore.
## Feature flag rules

Details: docs/feature-flags.md, ADR 0020.

- New user-visible behaviour ships behind a flag: add it to `config/flags.json` (description,
  owner, `"default": false`, expiry date) and guard the new path with `isEnabled('<name>', ctx)`
  (API, `apps/api/src/flags.ts`), `useFlag('<name>')` (web, `apps/web/src/lib/flags.ts`) or
  `is_enabled("<name>", user_id=...)` (worker). Literal names only; `pnpm check:flags` enforces it.
  Keep the old path working and test both (`FLAGS_ON=<name>`).
- Rollout: `pnpm flags:sync` creates the flag at 0 %; then internal users or one organization,
  then a percentage, then 100 % in PostHog, watching `pnpm journeys:report` and errors. Never
  change rollout from code, and never call PostHog's flag API or store flag state yourself.
- After full rollout, a follow-up PR deletes the old path, every check of the flag and its
  catalog entry, and archives it in PostHog. Expired or unused flags show as `check:flags`
  warnings: treat them as work.

## Marketing rules

Details: docs/marketing.md, ADR 0021.

- Public pages and posts live in `apps/site`, never in the SPA. Posts are Markdown/MDX in
  `apps/site/src/content/blog/`; the front matter schema enforces title/description limits.
- Every page renders `<Base>` (it carries the SEO head); add JSON-LD through its `jsonLd` prop.
  CTAs are links with `data-cta="<id>"` (event `site_cta_clicked`); no other tracking code.
- No media in git: images by absolute URL. Keep the Lighthouse budgets green; do not lower them.
- `pnpm geo:check` is manual and uses the claude CLI on a subscription with the model from
  `config/geo.json`; never add an API key or a CI job for it.

## UI rules

Details: docs/ui.md, DESIGN.md, ADR 0023. Look at `/dev/ui` (`pnpm dev`) before building UI.

- Build screens only from `apps/web/src/components/ui` and `components/patterns`. Missing
  something? Add the shadcn/ui component with its CLI (`pnpm dlx shadcn@latest add <name>` in
  `apps/web`, then `cn` from `@/lib/utils`, check its dependencies' licenses) and add it to the
  gallery (`src/dev/ui-gallery.tsx`). No other component libraries.
- Tokens only: colors through the semantic Tailwind tokens (`bg-background`, `text-muted-foreground`,
  `bg-primary`, `text-destructive`...), spacing and sizes from the Tailwind scale, radius from
  `--radius`. No hex/rgb, palette classes (`text-gray-500`), arbitrary values (`text-[13px]`) or
  inline styles in app code; new tokens go into `src/index.css` and DESIGN.md.
- Every data screen covers loading, empty and error (`QueryView`, `DataTable`, `EmptyState`,
  `ErrorState`); destructive actions go through `ConfirmDialog`; it works in light and dark
  and at 390px wide.
- Copy: sentence case, a verb on every button ("Create project"), say what happened and what to
  do next, no blame, no exclamation marks, no invented facts or customers.
- `pnpm e2e` runs axe on every page and the gallery; add new pages to `e2e/a11y.spec.ts`. A
  visual change is accepted with the `visual-change-approved` PR label, never by committing
  screenshots (docs/ui.md).
- When the `impeccable` skill is installed (`npx impeccable install`, docs/ui.md), run
  `/impeccable critique` and `/impeccable audit` on the screens you changed and fix what they
  find. Do not vendor the skill into this repository.

## PRs and releases

Details: docs/releases.md.

- PR title rule: the title must be a Conventional Commit (`feat: ...`, `fix(api): ...`,
  `chore: ...`) because the squash-merge title is the commit release-please turns into the
  changelog; `feat`/`fix` titles are user-facing release notes, so write them for users.
- Close the tracker item from the PR title or body: `Fixes APP-123` (Plane, default), or
  `Closes #<issue>` with `TRACKER=github`. The release then comments "Released in vX.Y.Z" on it
  (never closes it); a bare mention gets nothing.
- Never create tags or releases by hand; merging the release-please PR does it.

## Security rules

- Tenant tables: always `orgId()` + `tenantIsolation()`, always accessed via `withTenant`
  (API) or a transaction that sets `app.org_id` (worker). Never query them with the
  migration/owner role. The API refuses to start if its DB role can bypass RLS.
- Never log secrets, tokens, cookies or request bodies; the logger redacts common paths
  and drops query strings.
- Validate all input with Zod/dataclasses; never build SQL with string concatenation.
- Every place an email address enters (sign-up, SSO, email change, invitations, any new auth
  plugin) goes through `assertAllowedEmail` (`apps/api/src/signup-guard.ts`, disposable list from
  `mailchecker`); never add an own domain list or a runtime download (docs/security.md).
- New dependencies must pass `pnpm check:licenses` (allowlist in `scripts/license-check.mjs` and
  `deny.toml`): permissive licenses plus MPL-2.0 (file-level copyleft, no obligations on our
  code while unmodified). GPL/LGPL/AGPL/EUPL/SSPL/BUSL and other copyleft or source-available
  licenses stay banned for code dependencies (infrastructure containers are separate, see
  docs/LICENSES.md). Never add an exception, a license or an `ALIASES` entry to make the gate
  pass; ask a human (docs/adr/0005-license-policy.md).
- We never modify dependency files: no `pnpm patch`/`patch-package`, no edits in
  `node_modules`/`.venv`/vendored copies, no forks swapped in for the upstream package. Fixes
  go upstream (issue or PR); until a release lands, work around it in our own code.
- No real secrets, client names or private data in the repo, ever. Example values use
  `example.com` and `local-dev-*`.

## Never

- Bypass or disable RLS, run the app as the DB owner/superuser, or add `BYPASSRLS`. The one
  exceptions are `withOperatorRead` (read-only) and `withPlatformAudit` (org-less `operator.*`
  audit rows only), both operator console only (docs/admin.md): never call them elsewhere or add
  another role switch.
- Commit `.env`, credentials, a decrypted `deploy/env/*.env`, media/binary files, or generated
  `dist/`, `target/`, `.venv/`.
- Add Next.js/Vercel-specific code, or GPL/LGPL/AGPL/SSPL/BSL code dependencies (infra
  containers run unmodified are exempt, see docs/LICENSES.md).
- Patch, fork-in-place or edit a dependency's files (fixes go upstream).
- Push to `main` without `pnpm check` green, or force-push.
