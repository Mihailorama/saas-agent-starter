# 0009. LLM-ops: prompts in git, evals in CI, quality data in PostHog or Langfuse

Status: accepted (open owner decisions under "Open")

## Context

ADR 0008 records every LLM call (`ai_calls`, the EU AI Act audit record). Recording is not quality
control: nobody notices when a prompt edit, a model update or a shift in user input makes the
output worse. Owner rules (2026-11-06): no own analytics or score tables; quality data lives in
external tools, PostHog Cloud by default (EU or US region, accounts created by the owner) and a
self-hosted Langfuse when a client or the RU contour forbids sending data out. No LLM API key in CI
or scripts: real-model work runs on the owner's Claude subscription.

## Decision

**In the repo**

- **Prompts are code.** `prompts/<purpose>/<name>.v<N>.md`, loaded by explicit id and version
  (`worker/prompts.py`); id and version go on every `ai_calls` row and every PostHog generation.
  `prompts/lock.json` pins each released version's SHA-256; `tests/test_prompts.py` fails on an
  edited version or a prompted purpose without an eval.
- **Offline evals (Promptfoo).** Golden set per purpose in `evals/<purpose>/` (`input` = the exact
  user message, `recorded_output` = a good answer), rule assertions plus an `llm-rubric` judge using
  `prompts/judge/<purpose>.v<N>.md`; gate on the mean score (`gate.minScore`).
  - `pnpm eval`: replays recorded outputs, rule assertions only, and says so.
  - `pnpm eval --fake-llm`: replay plus a fake judge, so dataset, assertions and judge-prompt
    rendering are checked. Part of `pnpm check`, so CI runs it; no key.
  - `pnpm eval:real`: the real model and the real judge, through the logged-in `claude` CLI
    (`claude -p --model <explicit> --tools "" --system-prompt <prompt file>`), i.e. the Claude
    subscription; Promptfoo then grades the outputs with the same assertions. Local only. The
    Promptfoo container cannot use the host's Claude login, so the CLI calls run on the host and
    Promptfoo receives their results. Caveat: Claude Code may add the user's own memory
    (CLAUDE.md) to the context, and `--bare` would disable subscription auth; run it from an
    account whose memory does not steer answers, and read the outputs in `.out/real.jsonl`.
  - Promptfoo runs as a container (`ghcr.io/promptfoo/promptfoo`, compose profile `eval`): its npm
    tree contains LGPL-3.0, Artistic-2.0 and unlicensed packages, which the code-dependency gate
    (ADR 0005) rejects. Listed in docs/LICENSES.md.
- **Golden set from production.** `pnpm eval:pull --org <id> --purpose <p> [--call <id>]...` reads
  logged calls (ai_calls + S3 content, each export audit-logged) into the gitignored
  `evals/<purpose>/pulled.jsonl`; a human anonymizes them before moving them into `dataset.jsonl`.
- **Metrics.** The gateway emits `ai_calls_total`, `ai_call_latency_seconds`, `ai_cost_usd_total`
  (names agreed with the Grafana `LLM` dashboard, ADR 0010), alerts `AiErrorRate` and
  `AiCostSpike`. No score metrics: scores live in the tools.

**In PostHog (default) and/or Langfuse (self-hosted fallback)**

- **Generations.** With `POSTHOG_KEY` + `POSTHOG_HOST` the worker sends one `$ai_generation`
  per call through PostHog's capture API (`worker/posthog.py`, no SDK): `$ai_trace_id` and
  `$ai_span_id` are our OTel trace and span ids (the worker always installs a tracer provider, so
  every call has them), plus model, provider, tokens, latency in seconds, `$ai_total_cost_usd`,
  error flag and class, and our `ai_call_id`, purpose and prompt template/version. Privacy mode
  (`POSTHOG_PRIVACY_MODE`, default `true`) leaves `$ai_input` / `$ai_output_choices` out, which is
  what PostHog's own SDK privacy mode excludes. Best effort: a PostHog outage never fails a call.
  With `--profile llmops` the same spans go to Langfuse over OTLP.
- **User feedback.** The AI-answer thumbs (ADR 0012, `apps/web/src/lib/analytics.ts`) send a
  PostHog AI-feedback survey response and a Langfuse score keyed by `ai_calls.trace_id`, so they
  attach to the generation above. One thumbs path; this ADR adds nothing to it.
- **Online LLM-as-a-judge and drift.** The tools' own evaluators, configured as code:
  `pnpm llmops:evaluators [--apply]` creates, from the same judge prompt and judge model as the
  offline eval, a Langfuse evaluator + evaluation rule (10 % sample of `GENERATION` observations,
  `LLMOPS_EVAL_SAMPLING`) and a PostHog evaluation (`llm_judge`, 10 % rollout on
  `ai_purpose`). Dry run without `--apply` or without keys; existing names are skipped. Drift =
  the judge score trend per prompt version in the tool, with the tool's alerts.
- **Full profile `llmops`.** Langfuse 4.76.0 web + worker and ClickHouse 26.3, on our Postgres
  (own database), Redis (db 1) and S3 (own bucket); memory limits per container; ClickHouse tuned
  for small hosts. `pnpm langfuse:prompts` publishes repo prompts as Langfuse prompt versions
  labeled `v<N>` (git stays the source of truth).

## Verified facts (vendor docs, checked 2026-11-06)

Quotes were checked against the live pages; PostHog/Langfuse claims were cross-checked by two
other model families (Gemini, GPT). Live-verified locally against Langfuse 4.76.0: span ->
`GENERATION` with our trace/span ids, public-key-only browser score, prompt publishing, and
evaluator + rule creation through the v2 API.

- PostHog `$ai_generation` properties (`$ai_trace_id`, `$ai_span_id`, `$ai_model`,
  `$ai_provider`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency` "in seconds",
  `$ai_is_error`, `$ai_error`, `$ai_total_cost_usd`, `$ai_input`, `$ai_output_choices`):
  [manual capture](https://posthog.com/docs/ai-observability/installation/manual-capture).
- Privacy mode "excludes the `$ai_input` and `$ai_output_choices` properties from being
  captured"; model, provider, tokens, costs, latency and HTTP status are still sent
  ([privacy mode](https://posthog.com/docs/ai-observability/privacy-mode)). Sending raw capture
  events without those two properties is our equivalent; PostHog does not state that in words.
- Capture API: `POST /i/v0/e/` with `api_key`, `event`, `distinct_id` (plus optional
  `properties`, `timestamp`); hosts `https://eu.i.posthog.com` / `https://us.i.posthog.com`
  ([capture API](https://posthog.com/docs/api/capture)). The `phc_` project token may be public
  ([privacy](https://posthog.com/docs/privacy)).
- PostHog Evaluations: `POST /api/projects/:project_id/evaluations/`, personal API key with scope
  `evaluation:write`, types `hog`, `llm_judge`, `sentiment`; LLM judges need a provider API key in
  the project ([API](https://posthog.com/docs/api/evaluations), [evals](https://posthog.com/docs/ai-evals)).
  Not found: whether Evaluations is GA, and the full enum of `output_type` / provider names; the
  script follows the reference example and must be checked after the first `--apply`.
- Langfuse: "you can set up and manage LLM-as-a-Judge evaluation programmatically through the
  public API" ([LLM-as-a-judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge));
  endpoints `/api/public/v2/evaluators` and `/api/public/v2/evaluation-rules`
  ([OpenAPI](https://cloud.langfuse.com/generated/api/openapi.yml)); running a judge needs an LLM
  connection ([LLM connections](https://langfuse.com/docs/administration/llm-connection));
  evaluators are in the MIT core ([license key](https://langfuse.com/self-hosting/license-key)).
- Langfuse self-hosting (v4 current, v3 security patches "until end of January 2027";
  Postgres >= 15, ClickHouse >= 25.12 with `CLICKHOUSE_CLUSTER_ENABLED=false` for a single
  container, Redis/Valkey with `noeviction`, S3 path style for SeaweedFS; sizing "at least 4
  cores and 16 GiB"): [v3 to v4](https://langfuse.com/self-hosting/upgrade/upgrade-guides/upgrade-v3-to-v4),
  [ClickHouse](https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse),
  [cache](https://langfuse.com/self-hosting/deployment/infrastructure/cache),
  [blob storage](https://langfuse.com/self-hosting/deployment/infrastructure/blobstorage),
  [Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose).

## Open (owner decisions)

- **Online judges need content and a provider key.** With privacy mode on, PostHog has no prompt
  or output to judge, and our spans carry no content (ADR 0008), so a Langfuse judge sees empty
  `input`/`output`. Online LLM-as-a-judge needs (a) `POSTHOG_PRIVACY_MODE=false` (covered by DPA
  and user information) or, for Langfuse, opt-in content on the spans (not built; docs/TODO.md),
  and (b) an LLM provider API key stored in PostHog or Langfuse, which the subscription-only rule
  does not cover. Until decided, evaluators are defined as code but judge nothing useful.
- **Does the small single-server tier run Langfuse?** Default is PostHog Cloud (no extra RAM);
  Langfuse costs about 1.8 to 1.9 GiB measured (docs/STACK.md).

## Consequences

- A prompt change is a reviewed diff with an eval result (`pnpm eval:real` in the PR), not an
  edit in a UI.
- No quality data in our database: dashboards, judge scores and feedback are in the tool; Postgres
  keeps only the audit record (`ai_calls`).
- PostHog receives call metadata for every call; that is a processor to list in the DPA.
