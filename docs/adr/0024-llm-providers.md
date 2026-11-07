# 0024. LLM providers: LiteLLM in the gateway, CLI subscriptions by default, BYO and on-prem

Status: proposed (blocked on the license gate, see "Consequences")

## Context

ADR 0008 put every model call behind `Gateway.call_llm` with two hand-written adapters
(Anthropic SDK, OpenAI SDK with a base URL) and our own price table. Owner decisions
(2026-11-07): product models can be anything (vendor CLI subscriptions, API keys, aggregators,
custom OpenAI-compatible endpoints, self-hosted servers); cost is not the driver, pluggability
is; CLI subscriptions are on by default and the primary mode, with their terms-of-use risk
documented once; organizations may bring their own provider; on-prem serving uses vLLM for many
users and Ollama only for dev.

## Decision

- **LiteLLM Python SDK in the worker** (`worker/providers.py`, `litellm.acompletion`) is the one
  path to every provider; the gateway keeps everything it owned (registry and contours, purposes,
  prompt files, `ai_calls`, S3 content, OTel spans, PostHog `$ai_generation`, privacy mode).
  Providers are data: `providers` in `config/ai-models.json` maps a name to a kind (`cli`, `api`,
  `aggregator`, `custom`, `local`), a LiteLLM prefix and the env variables of its key and base
  URL, so a new LiteLLM-supported vendor is a config entry. The key is always passed explicitly,
  so LiteLLM never picks an operator key from the environment for another endpoint. License:
  MIT for everything outside `enterprise/`
  ([LICENSE](https://github.com/BerriAI/litellm/blob/main/LICENSE): "All content that resides
  under the "enterprise/" directory ... is licensed under the license defined in
  "enterprise/LICENSE""). The enterprise code ships as the separate `litellm-enterprise` package
  (`LicenseRef-Proprietary`), pulled in only by the `proxy` extra, which we do not install; the
  `litellm` wheel excludes `litellm/proxy/enterprise` (checked 2026-11-07, litellm 1.108.2).
- **Prices from LiteLLM's model cost map** in `Gateway.price_of`, explicit `pricePer1kTokens`
  overrides first; the bundled copy (`LITELLM_LOCAL_MODEL_COST_MAP=True`), never a fetch at
  import. Only for vendor APIs and aggregators; zero counts as unknown; fail closed unless
  `"unmetered": true`.
- **CLI subscriptions in a separate `llm-cli` container**, an internal OpenAI-compatible shim
  (`POST /<cli>/v1/chat/completions`, Node `http` + `child_process`, no dependencies), so LiteLLM
  calls it like any endpoint and the worker image has no CLIs or logins. One adapter per CLI
  (Claude Code `claude -p`, Codex `codex exec`, Gemini CLI `gemini -p`; others via an argv
  template), explicit model, no tools, JSON output and usage where available, timeout with kill.
  Logins are mounted files, read into the environment of that subscription's CLI runs only.
- **Concurrency in llm-cli, fallback in the gateway.** Per subscription a concurrency limit; a
  bounded FIFO queue per CLI; round-robin across subscriptions; a rate-limited subscription
  cools down and the request moves on; all limited / queue full -> 429. The gateway then calls
  the registry `fallback` if configured. The limiter sits where the logins are: a Temporal task
  queue per subscription would limit per worker process, not per subscription, needs one queue
  per login, and would not cover the eval path.
- **Unmetered = limited by calls/tokens.** Subscription and self-hosted models have no cost, so
  plans get `llmUsageMonthly` (`calls`, `tokens`), checked before each unmetered call.
- **BYO providers** (`ai_providers`, tenant table with RLS): encrypted with the webhook key ring,
  bound to org and row, audit-logged, used only for the owning org, plan feature `byoLlm`. Custom
  base URLs pass the webhook SSRF guard and the connection is pinned to the checked IP (an
  `httpx2` transport that rewrites the host to the IP and keeps Host and SNI).
- **On-prem**: compose profile `local-llm` with vLLM (GPU, NVIDIA runtime), a vLLM embeddings
  server (`--runner pooling`) and Ollama; `local-llm-cpu` with vLLM's CPU image for smoke tests.
- **Evals**: `pnpm eval:real` runs the product prompt on the configured `<provider>:<model>` (CLI
  adapter on the host, or LiteLLM via `python -m worker.complete`); the judge is
  `claude_cli:claude-opus-5-5` through the Claude subscription. CI stays key-free.

## Alternatives

- **LiteLLM Proxy** (the official container) instead of the SDK: one more service with its own
  config of model routes (duplicating the registry), and BYO custom endpoints would be called
  from the proxy, outside our SSRF pinning. Its image is infrastructure, so the code license gate
  would not apply. The fallback if the gate blocker below is not lifted.
- **Our own adapters per vendor** (status quo): every new vendor is code, plus our own price table.
- **Portkey / other gateways**: comparable, less mainstream in Python; OpenRouter alone covers
  aggregation but not local servers or subscriptions.
- **CLIs inside the worker image**: proprietary binaries and logins next to the database
  credentials, and the worker image would carry Claude Code.

## Consequences

- **License gate (blocker).** `pnpm check:licenses` rejects 8 transitive dependencies of LiteLLM.
  Seven are permissive packages whose metadata the gate cannot map (only the classifiers "BSD
  License" or "Apache Software License", or a license text in the License field): `jinja2`,
  `fastuuid`, `aiosignal`, `s3transfer`, `tokenizers`, `tiktoken`, `python-dateutil` 2.9 (dual
  Apache/BSD; 4.0 declares BSD-3-Clause but `botocore` pins `<3`). One has a license outside the
  allowlist: `regex` (`Apache-2.0 AND CNRI-Python`; CNRI-Python is part of the Python license
  stack). No gate exception was added (ADR 0005). Unblocking needs an owner decision: either
  extend ADR 0005 (map those classifiers, accept `CNRI-Python`), or switch the LiteLLM route to
  the proxy container (above).
- Serving many users through consumer subscriptions can break the vendors' terms; documented in
  docs/llm-providers.md, the mode stays on.
- The llm-cli image contains the proprietary Claude Code CLI: CI does not publish it; operators
  build it and keep it in a private registry.
- `OPENAI_BASE_URL` is replaced by `OPENAI_COMPATIBLE_BASE_URL`/`_API_KEY` (provider
  `openai_compatible`), because `openai` is now the first-party OpenAI API provider.
