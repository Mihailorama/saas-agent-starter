# 0009. LLM-ops: a quality loop around every LLM call (Lite by default, Langfuse as Full)

Status: accepted (one open owner decision, see "Open")

## Context

ADR 0008 records every LLM call. Recording is not quality control: nobody notices when a prompt
edit, a model update or a shift in user input makes the output worse. The owner's target is one
server (8 CPU / 24 GB) running the whole stack, so the default loop must add no new services; a
heavier tool may be an option for production.

## Decision: Lite (default, no new services)

- **Prompts are code.** Templates live in `prompts/<purpose>/<name>.v<N>.md`; `worker/prompts.py`
  loads them by explicit id and version (`prompts.load("project.summary/system", 1)`), and the
  id/version go on every `ai_calls` row. A released version never changes: `prompts/lock.json`
  pins each file's SHA-256 and `tests/test_prompts.py` fails on an edited version, so a change
  is a new `.v<N+1>.md` file, reviewed and evaluated like code.
- **Scores.** `ai_scores` (call, source `user|judge|rule`, name, numeric value, comment, actor,
  judge call): tenant table with RLS and append-only for the app role, like `ai_calls`. Confirm
  and correct on an AI summary write a user score (`review` = 1 / 0) in the same transaction.
  No content is stored: the judge's reasoning stays in its own call's S3 object
  (`judge_call_id`).
- **Offline evals.** Promptfoo with a golden set per purpose in `evals/<purpose>/`
  (`dataset.jsonl` = the exact user message as `input` plus a `recorded_output`), rule
  assertions plus an `llm-rubric` judge that uses the same judge prompt file as production
  (`prompts/judge/<purpose>.v<N>.md`). `pnpm eval` gates on the mean score
  (`gate.minScore`). Without `ANTHROPIC_API_KEY` it replays the recorded outputs through the
  rule assertions only and says so; `--fake-llm` adds a fake judge and is part of `pnpm check`
  (checks dataset, assertions and judge-prompt rendering; key-free). The CI job `eval` runs the
  real thing only when the secret exists. Model ids in an eval must be registered for the
  purpose in `config/ai-models.json`, like in the gateway.
- **Promptfoo runs as a container** (`ghcr.io/promptfoo/promptfoo`, compose profile `eval`),
  not as an npm dependency: Promptfoo is MIT, but its dependency tree contains LGPL-3.0
  (`@img/sharp-libvips-*`), Artistic-2.0 and unlicensed packages, which the code-dependency gate
  (ADR 0005) rejects. As an unmodified tool container it falls under the infrastructure rule and
  is listed in docs/LICENSES.md.
- **Golden set from production.** "Add to golden set" on a call writes a pending
  `ai_dataset_items` row; `pnpm eval:pull --org <id>` turns pending items into Promptfoo cases in
  `evals/<purpose>/pulled.jsonl` (gitignored: real prompts and outputs) and marks them
  exported. A human anonymizes them before moving them into `dataset.jsonl`.
- **Drift control.** A Temporal schedule `ai-drift-check` (`AI_DRIFT_CRON`, default daily
  03:00 UTC; created by the worker when `AI_JUDGE_PROVIDER`/`AI_JUDGE_MODEL` are set) samples up
  to `AI_DRIFT_SAMPLE` recent, unscored calls per purpose and org, runs the judge through
  `call_llm` (purpose `judge`, model from the registry, logged like any call) and appends judge
  and rule scores. Each call is scored once (retry-safe).
- **Metrics and alerts.** Worker and API export OTel metrics, which arrive in Prometheus as
  `app_ai_calls_total`, `app_ai_cost_total`, `app_ai_latency_ms_*` and `app_ai_score_*`
  (labels: purpose, prompt template/version, model, source, status; never content). Example
  rules in `infra/otel/alerts.yml`: judge score below 0.7, users correcting most outputs, error
  rate above 10 %, cost three times the weekly average. Names checked against a real Prometheus
  3.15 OTLP receiver.
- **Admin page "LLM Ops"** (`/llm-ops`, org admins): calls per day and average judge/user
  score per day (Recharts, MIT), a prompt-version comparison (calls, error rate, judge and user
  score with counts, cost, latency per template/version/model), the filterable call log, and a
  call detail page with scores, trace link (`TRACE_URL_TEMPLATE`), "Add to golden set" and the
  prompt/response content, loaded from S3 only on an explicit click and audit-logged
  (`ai_call.content_viewed`).

## Decision: Full (compose profile `llmops`) = Langfuse

Langfuse is added when a team wants a trace UI, prompt playground, annotation queues and
dataset experiments on top of the same data. It does not replace Lite: Postgres (`ai_calls`,
`ai_scores`) stays the record, Langfuse is a copy.

- What the profile runs: `langfuse/langfuse` and `langfuse/langfuse-worker` 4.76.0 plus
  `clickhouse/clickhouse-server` 26.3.62.3, reusing our Postgres server (own database
  `langfuse`), our Redis (db 1) and our S3 (bucket `langfuse`). The optional `ai-gateway`
  container of the official compose file is left out. Memory limits per container, ClickHouse
  tuned for small hosts (`infra/langfuse/`).
- Spans: the worker sends the same GenAI spans (no content) to Langfuse's OTLP endpoint
  (`WORKER_OTEL_TRACES_ENDPOINT`, header `x-langfuse-ingestion-version: 4`). Verified locally:
  the LLM span arrives as a `GENERATION` observation whose id is our `span_id` and whose trace id
  is our `trace_id`, so `TRACE_URL_TEMPLATE` links a call to its Langfuse trace.
- Scores: the worker pushes judge and rule scores with the secret key (score id = our
  `ai_scores.id`). User feedback (confirm = 1, correct = 0) is sent from the browser with the
  Langfuse browser SDK (`LangfuseWeb`, public key only, which can create scores and nothing
  else) to the call's trace, as the owner requires (2026-11-06); the API returns the trace ids
  with the review response and serves the public key at `/api/client-config`. Verified against
  Langfuse 4.76.0: a public-key-only score via the browser SDK's endpoint is accepted (207, one
  success), while `POST /api/public/scores` with the public key alone is 401.
- Prompts: `pnpm langfuse:prompts` publishes every repo prompt version as a Langfuse prompt
  version labeled `v<N>` (created only if the label is missing, so it is safe on every deploy).
  Git stays the source of truth; editing a prompt in the Langfuse UI does not change production.

Langfuse facts used (official docs, checked 2026-11-06; quotes verified mechanically, one
independent model family cross-checked):

- v4 is the current self-hosted major; v3 is deprecated and gets "security patches until end of
  January 2027" ([v3 to v4](https://langfuse.com/self-hosting/upgrade/upgrade-guides/upgrade-v3-to-v4)).
- Infrastructure: web (3000) + worker (3030), Postgres (v4: "minimum PostgreSQL version is 15",
  [postgres](https://langfuse.com/self-hosting/deployment/infrastructure/postgres)), ClickHouse
  (v4 needs 25.12+, `CLICKHOUSE_CLUSTER_ENABLED=false` for a single container, which is
  community-supported "development only",
  [clickhouse](https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse)),
  Redis/Valkey ("At least version 7 is required and the instance must have
  `maxmemory-policy=noeviction` configured"; Valkey 8+ listed,
  [cache](https://langfuse.com/self-hosting/deployment/infrastructure/cache)), S3 with
  `LANGFUSE_S3_EVENT_UPLOAD_*`/`LANGFUSE_S3_MEDIA_UPLOAD_*`, path style "Required for SeaweedFS
  and MinIO" ([blob storage](https://langfuse.com/self-hosting/deployment/infrastructure/blobstorage)).
  The official compose creates the bucket itself; SeaweedFS creates it on first write.
- Sizing: "at least 4 cores and 16 GiB of memory" for a Docker Compose VM
  ([docker compose](https://langfuse.com/self-hosting/deployment/docker-compose)); per component
  web/worker 2 CPU / 4 GiB each and ClickHouse "2 CPU, 8 GiB Memory"
  ([scaling](https://langfuse.com/self-hosting/configuration/scaling)). Our limits are far
  below that; see docs/STACK.md for what we measured.
- License: "All core Langfuse features and APIs are available in Langfuse OSS (MIT licensed)
  without any limits" ([license key](https://langfuse.com/self-hosting/license-key)). In OSS per
  the [self-host pricing table](https://langfuse.com/pricing-self-host): tracing, prompt
  management, playground, datasets and experiments, custom scores, LLM-as-a-judge evaluators,
  annotation queues, organization-level RBAC, SSO. Enterprise only: project-level RBAC,
  protected prompt labels, data retention, audit logs, server-side masking, UI customization,
  SCIM / organization and instance management APIs.
- OTLP: HTTP only (JSON or protobuf, "gRPC is not supported yet") at `/api/public/otel`
  (`/v1/traces`), Basic auth with the key pair; maps `gen_ai.request.model`/`response.model`
  and `gen_ai.usage.*` ([OpenTelemetry](https://langfuse.com/integrations/native/opentelemetry)).
- Scores API: `POST /api/public/scores` takes a list (202/207); a score with the same `id`,
  `name` and date replaces the earlier one
  ([scores via SDK](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk)).
- Prompts API: `POST /api/public/v2/prompts` adds a version to an existing name; `GET
  /api/public/v2/prompts/{name}?label=` (folder names with `/`, URL-encoded).

## Lite vs Full: criteria

Stay on Lite while: one or a few AI purposes, admins look at quality weekly, the drift check
and the LLM Ops page answer "did it get worse and since which version", memory is tight.

Move to Full when at least one holds: people outside engineering review outputs every day
(annotation queues), prompts are iterated in a playground with non-developers, you need
trace-level drill-down across multi-step agent runs, or you run many purposes and want
dataset experiments per version. Full costs about 1.8 to 1.9 GiB of RAM on our measurements
(docs/STACK.md), a ClickHouse to operate and back up, and a second place holding (redacted)
traces. Run it on its own host or a managed Langfuse once traffic grows: its own sizing guide
asks for 16 GiB.

## Open (owner decision)

The owner requires user feedback to land in Langfuse as trace scores. That is implemented for
the Full profile. Whether the small single-server tier ("S-tier") also runs Langfuse, and so
spends about 1.9 GiB RAM and ClickHouse operations on it, is not decided; until then S-tier
stays on Lite and user feedback is kept in `ai_scores` only. Measured numbers: docs/STACK.md.

## Consequences

- A prompt change is a reviewed diff with an eval result, not an edit in a UI.
- Quality is measured continuously, but the judge is itself a model: its scores are a trend
  signal, not ground truth. Spot-check judge calls (they are linked from each score).
- The drift check sends a sample of production inputs/outputs to the judge model. It is an AI
  use of its own (purpose `judge` in `config/ai-transparency.json` and the registry).
- Promptfoo, the eval engine, needs Docker locally and in CI.
