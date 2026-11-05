# 0008. AI layer: one gateway, logged calls, human review

Status: accepted

## Context

Products built on this starter call LLMs. Customers, auditors and the EU AI Act
([docs/ai-act.md](../ai-act.md)) ask the same questions: which model produced this, when, for
whom, at what cost, can a human check it, and can we prove it later. Answering them after the
fact is impossible if calls are scattered across the code base.

## Decision

- **One gateway.** Every LLM call goes through `Gateway.call_llm` in
  `services/worker-py/worker/ai.py`, inside Temporal activities (ADR 0004). Arguments are
  explicit: purpose, messages, `model`, `provider`, org, actor, prompt template id + version,
  `max_tokens`. There is no default model anywhere; a feature without a configured model is off.
- **Model registry.** `config/ai-models.json` lists, per contour (`AI_CONTOUR`, e.g. `eu`/`ru`),
  which provider/model pairs may serve which purpose, with a price per 1k tokens. The gateway
  refuses anything else with a non-retryable `ModelNotAllowed`. The same file feeds the public
  `/ai-transparency` page, so the page cannot drift from what the code allows.
- **Providers.** `anthropic` (official `anthropic` SDK) and `openai_compatible` (official
  `openai` SDK with `OPENAI_BASE_URL`, for self-hosted or in-country endpoints). Keys come from
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. A provider is a plain async function, so tests inject
  a fake one; `tests/test_providers.py` checks both SDK adapters against canned HTTP responses.
- **Append-only log.** One `ai_calls` row per call (also for provider errors): org, actor,
  purpose, provider, requested and reported model, template id/version, token counts, cost,
  latency, status, error class, trace/span id, contour. It is a tenant table with RLS; the app
  role has no UPDATE/DELETE/TRUNCATE on it (`packages/db/src/migrate.ts`, tested in
  `packages/db/test/rls.test.ts`).
- **Content outside the database and telemetry.** Request and response JSON go to the
  `AI_CONTENT_BUCKET` S3 bucket (`<org>/<yyyy>/<mm>/<dd>/<call id>/{request,response}.json`);
  the row holds the keys and `content_expires_at` (`AI_CONTENT_RETENTION_DAYS`). Logs and
  spans carry ids and counts only. The worker talks to S3 with an ~80-line SigV4 client (`worker/s3.py`) because
  boto3's dependency tree fails the license gate (ADR 0005).
- **OpenTelemetry.** One `CLIENT` span per call named `chat {model}` with the GenAI semantic
  conventions for client inference spans: `gen_ai.operation.name`, `gen_ai.provider.name` (and
  the deprecated `gen_ai.system` for older backends), `gen_ai.request.model`,
  `gen_ai.request.max_tokens`, `gen_ai.response.model`, `gen_ai.response.id`,
  `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `error.type`, plus
  `gen_ai.input.messages_ref` / `gen_ai.output.messages_ref` pointing at the S3 objects. The
  content attributes (`gen_ai.input.messages`, `gen_ai.output.messages`) are opt-in in the
  conventions and deliberately not set. The span joins the Temporal workflow trace, and its
  trace/span id is stored on the row, so a row leads to its trace and back.
- **Human oversight.** AI output stored on an entity carries `ai_status`
  (`generated` | `confirmed` | `corrected`), `reviewed_by`, `reviewed_at` and `ai_call_id`.
  Confirm/correct are ordinary audit-logged API mutations. The web shows an "AI-generated" badge
  that links to `/ai-transparency`. Org admins read the log at `/ai-calls` and export JSONL.

## Alternatives

- **An LLM proxy service** (LiteLLM, Portkey, Langfuse AI gateway): central keys and logging
  for many apps, but another service to run and its logs live outside our tenancy/RLS model.
  Worth it once several products share providers; `call_llm` stays the single call site either
  way.
- **Framework abstractions** (LangChain, LlamaIndex): more surface than one function, and they
  hide the request we need to log.
- **Prompt content in spans**: convenient in trace UIs, but it copies personal data into a
  second store with its own retention and access rules. Use the `*_ref` attributes instead.

## Using Langfuse as a UI (optional, not shipped)

[Langfuse](https://github.com/langfuse/langfuse) can display the same spans. Facts below are
from its docs and repository, checked 2026-11-05:

- **License**: MIT ("MIT Expat") for everything outside the `ee/`, `web/src/ee/`,
  `worker/src/ee/` and `packages/shared/src/server/ee/` directories, which are under a separate
  commercial license; some add-on features need a license key
  ([LICENSE](https://github.com/langfuse/langfuse/blob/main/LICENSE),
  [self-hosting](https://langfuse.com/self-hosting)). Not added to this repo's compose for that
  reason and because of the infrastructure below.
- **Infrastructure**: two containers (Langfuse Web, Langfuse Worker) plus PostgreSQL,
  ClickHouse (traces/observations), Redis or Valkey (queue and cache; Valkey >= 8 officially
  supported, `maxmemory-policy=noeviction` required) and S3/blob storage. Langfuse recommends
  at least 4 cores and 16 GiB of memory for a single-VM Docker Compose install
  ([architecture](https://langfuse.com/self-hosting),
  [cache](https://langfuse.com/self-hosting/deployment/infrastructure/cache),
  [Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose)).
  Its reference compose file uses Redis and MinIO; under this repo's policy swap in Valkey and
  an S3 store that is not AGPL (e.g. SeaweedFS, AWS S3, R2).
- **Ingestion**: OTLP over HTTP (JSON or protobuf) at `/api/public/otel`; gRPC is not
  supported. Auth is HTTP Basic with the project's public/secret key pair
  ([OpenTelemetry docs](https://langfuse.com/integrations/native/opentelemetry)). It maps
  `gen_ai.request.model`/`gen_ai.response.model` to the model and `gen_ai.usage.*` to usage.

The worker exports OTLP over gRPC, so route it through the OTel Collector of the
`observability` profile and add an HTTP exporter in `infra/otel/collector.yaml`:

```yaml
exporters:
  otlp_http/langfuse:
    endpoint: https://langfuse.example.com/api/public/otel
    headers:
      Authorization: Basic ${env:LANGFUSE_BASIC_AUTH} # base64("pk-lf-...:sk-lf-...")
service:
  pipelines:
    traces:
      { receivers: [otlp], processors: [batch], exporters: [otlp_grpc/jaeger, otlp_http/langfuse] }
```

Langfuse will show model, tokens and latency per call but no prompt or completion text, since
the spans do not carry it. That is intended; the content stays in S3 under the retention you
set.

## Consequences

- Adding an AI feature is a recipe (AGENTS.md "Recipe: add an AI purpose"), not a design task.
- `ai_calls` grows with usage. Content retention is set per bucket; row retention follows the
  organization (rows are deleted with their organization).
- Content expiry is recorded, not enforced, by the app: configure a lifecycle rule on the
  bucket (see docs/TODO.md).
