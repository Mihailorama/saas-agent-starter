# LLM providers

Every model call goes through `Gateway.call_llm` (`services/worker-py/worker/ai.py`, ADR
[0008](adr/0008-ai-layer.md)); how it reaches a provider is decided by
[ADR 0024](adr/0024-llm-providers.md). Two routes, one gateway:

- **LiteLLM** (Python SDK in the worker, `worker/providers.py`): API keys, aggregators, custom
  OpenAI-compatible endpoints and self-hosted servers.
- **llm-cli** (a separate container, `services/llm-cli`): vendor CLI subscriptions, served as an
  internal OpenAI-compatible endpoint that LiteLLM calls like any other.

Whatever the route, the gateway keeps the same record: one `ai_calls` row per attempt, request
and response content in S3, one OTel span, one PostHog `$ai_generation` (privacy mode on by
default), prompt files with explicit versions, and the purposes/contours of
`config/ai-models.json`. Nothing is called that the registry does not list for the current
`AI_CONTOUR`.

## Provider matrix

`providers` in `config/ai-models.json` defines each provider; `contours` lists which
provider/model pairs may serve which purpose. Shipped providers:

| Provider            | Kind       | Route                  | Configure                                                 | Price / limit                 |
| ------------------- | ---------- | ---------------------- | --------------------------------------------------------- | ----------------------------- |
| `claude_cli`        | cli        | llm-cli: `claude -p`   | Claude Code login token in llm-cli (`claude setup-token`) | unmetered, calls/tokens limit |
| `codex_cli`         | cli        | llm-cli: `codex exec`  | Codex `auth.json` (`codex login`, ChatGPT plan)           | unmetered, calls/tokens limit |
| `gemini_cli`        | cli        | llm-cli: `gemini -p`   | Gemini CLI `oauth_creds.json` (Google login)              | unmetered, calls/tokens limit |
| `anthropic`         | api        | LiteLLM `anthropic/`   | `ANTHROPIC_API_KEY`                                       | LiteLLM cost map, spend limit |
| `openai`            | api        | LiteLLM `openai/`      | `OPENAI_API_KEY`                                          | LiteLLM cost map, spend limit |
| `gemini`            | api        | LiteLLM `gemini/`      | `GEMINI_API_KEY` (AI Studio)                              | LiteLLM cost map, spend limit |
| `xai`               | api        | LiteLLM `xai/`         | `XAI_API_KEY`                                             | LiteLLM cost map, spend limit |
| `moonshot`          | api        | LiteLLM `moonshot/`    | `MOONSHOT_API_KEY`                                        | LiteLLM cost map, spend limit |
| `openrouter`        | aggregator | LiteLLM `openrouter/`  | `OPENROUTER_API_KEY`; model ids like `anthropic/claude-…` | cost map or explicit price    |
| `openai_compatible` | custom     | LiteLLM `openai/`      | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY` | explicit price or unmetered   |
| `vllm`              | local      | LiteLLM `hosted_vllm/` | `VLLM_BASE_URL`, `VLLM_API_KEY`                           | unmetered, calls/tokens limit |
| `ollama`            | local      | LiteLLM `ollama_chat/` | `OLLAMA_BASE_URL`                                         | unmetered, calls/tokens limit |

Pick a model per purpose with the purpose's env pair, e.g. `AI_PROJECT_SUMMARY_PROVIDER` and
`AI_PROJECT_SUMMARY_MODEL` (unset = feature off; there is no default model). A provider that is not
configured (no `LLM_CLI_URL` for `cli`, no base URL for `custom`/`local`, no key for `api`/
`aggregator`) is refused with `ModelNotAllowed` before anything is sent: the gateway never lets
LiteLLM pick a base URL or key from the environment. LiteLLM prefixes
come from its provider docs ([vLLM](https://docs.litellm.ai/docs/providers/vllm): "hosted_vllm/
(for OpenAI compatible server)"; [Ollama](https://docs.litellm.ai/docs/providers/ollama): "We
recommend using ollama_chat for better responses."; [OpenAI-compatible](https://docs.litellm.ai/docs/providers/openai_compatible),
[OpenRouter](https://docs.litellm.ai/docs/providers/openrouter),
[xAI](https://docs.litellm.ai/docs/providers/xai),
[Moonshot](https://docs.litellm.ai/docs/providers/moonshot),
[Gemini](https://docs.litellm.ai/docs/providers/gemini); checked 2026-11-07).

**Prices.** `Gateway.price_of`: an explicit `pricePer1kTokens` in the registry wins, otherwise
LiteLLM's model cost map (USD, the copy bundled with the installed `litellm`; the worker sets
`LITELLM_LOCAL_MODEL_COST_MAP=True`, so nothing is fetched at import time). The map is used for
`api` and `aggregator` kinds only: a subscription, a local server or a custom endpoint is not
billed at a vendor's list price. A price of zero counts as unknown. Fail closed: a model without
a price is refused unless it is `"unmetered": true`. Unmetered models are limited by the plan's
`llmUsageMonthly` calls/tokens instead of money (docs/billing.md).

**Fallback.** A registry entry may name `"fallback": {"provider", "model"}`. When the call answers
rate-limited (HTTP 429, LiteLLM `RateLimitError`: a subscription out of quota, or llm-cli with every
subscription cooling down or its queue full), the gateway calls the fallback, if that provider is
configured and registered for the purpose, with its own price and limit checks. Every attempt is
its own `ai_calls` row, so the log shows the 429 and the call that answered. The shipped config
falls back from `claude_cli` to the `anthropic` API, which only takes effect once you set
`ANTHROPIC_API_KEY`.

## How to add each kind

1. **Another model of a shipped provider**: add `{provider, model, purposes, ...}` to the contour.
   Priced by LiteLLM's map, or add `pricePer1kTokens`; mark self-hosted and subscription models
   `"unmetered": true`.
2. **An API-key vendor LiteLLM supports** (Mistral, DeepSeek, Groq, Azure, Bedrock, ...): add
   `"<name>": {"kind": "api", "litellm": "<litellm prefix>", "baseUrl": "<vendor API URL>",
   "apiKeyEnv": "<ENV>"}` to `providers` and forward the env variable in `docker-compose.yml` and
   `compose.prod.yaml`. No code. `baseUrl` is required: the gateway always passes the base URL to
   LiteLLM, which would otherwise take one from the environment (`OPENAI_BASE_URL`,
   `ANTHROPIC_BASE_URL`, ...) and send prompts there.
3. **Aggregator**: as 2 with `"kind": "aggregator"`.
4. **Custom OpenAI-compatible endpoint**: `openai_compatible` with its two env variables, or a
   second entry (`"kind": "custom", "litellm": "openai", "baseUrlEnv": ..., "apiKeyEnv": ...`)
   for several endpoints.
5. **Self-hosted**: `vllm` / `ollama`, or another `local` entry; see "On-prem" below.
6. **Another CLI subscription**: in the llm-cli config (`infra/llm-cli/config.json`) add the CLI
   with a `command` argv template (`{model}`; the prompt always goes on stdin, never argv, so text
   starting with `--` is not parsed as an option and a large prompt does not hit `E2BIG`) and its
   subscriptions, install the CLI in `services/llm-cli/Dockerfile`, then add
   `"<name>_cli": {"kind": "cli", "cli": "<name>"}` to `providers`. Pick a CLI that reads the
   prompt from stdin and can run without tools, and put its tool-off flags in the template: the
   login sits in the run's HOME, and a tool that reads files would let a prompt injection copy it
   into the answer. llm-cli cannot check this for you.

## CLI subscriptions (default mode)

Subscriptions are the primary mode: the shipped registry lists `claude_cli`, `codex_cli` and
`gemini_cli` first, `.env.example` uses `claude_cli`, and `compose.prod.yaml` has an `llm-cli`
entry. The llm-cli container runs each CLI non-interactively with an explicit model, no tools and
structured output where the CLI has it:

| CLI         | Command (adapter in `services/llm-cli/src/cli.ts`)                                                                                                                                                                                                                                                                                                | Usage captured                                        | Login (mounted file)                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| Claude Code | `claude -p --model M --output-format json --tools "" --strict-mcp-config --no-session-persistence --system-prompt S` (prompt stdin)                                                                                                                                                                                                               | `usage` (incl. cache tokens), model from `modelUsage` | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` |
| Codex       | `codex exec --model M --json --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --sandbox read-only -c approval_policy="never" -c web_search="disabled" --disable shell_tool --disable unified_exec --disable view_image --disable multi_agent --disable goals -` (prompt stdin; no system flag, instructions lead the prompt) | `turn.completed.usage`                                | `~/.codex/auth.json` from `codex login`             |
| Gemini CLI  | `gemini --model M --output-format json --skip-trust --policy <deny-all.toml> -p " "` (prompt stdin, system prompt via `GEMINI_SYSTEM_MD`, `GOOGLE_GENAI_USE_GCA=true`)                                                                                                                                                                            | `stats.models.<m>.tokens`                             | `~/.gemini/oauth_creds.json` from a Google login    |
| others      | `command` template                                                                                                                                                                                                                                                                                                                                | none                                                  | as configured                                       |

Sources (checked 2026-11-07): Claude Code `claude --help` 2.1.319 and
[headless](https://code.claude.com/docs/en/headless) / [authentication](https://code.claude.com/docs/en/authentication)
docs ("generate a one-year OAuth token with `claude setup-token`"); Codex `codex exec --help`
0.167.0 and [non-interactive mode](https://developers.openai.com/codex/noninteractive); Gemini
CLI [reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)
("Prompt text. Appended to stdin input if provided. Forces non-interactive mode.") and
[system prompt](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/system-prompt.md).
CLI flags change between releases: the image pins each CLI version (`CLAUDE_CODE_VERSION`,
`CODEX_VERSION`, `GEMINI_CLI_VERSION` build args) and `services/llm-cli/test/` checks the adapters
against a fake binary. `max_tokens` is not passed: none of these CLIs has a flag for it. For Claude Code, `--tools ""`
turns off the built-in tools and `--strict-mcp-config` (without `--mcp-config`) loads no MCP
servers, so a run has no tools at all.

**No tools, so the login stays unreadable.** Each run's HOME holds the subscription's login
(Codex `auth.json`, Gemini `oauth_creds.json`; neither CLI takes a subscription login from an
environment variable). A tool that can read files or run commands would let a prompt injection
in user content copy that token into the answer, which is stored and shown. So every adapter turns
tools off, and the run's working directory is a scratch dir outside HOME. Checked against a local
mock of each vendor API, recording the tool list the CLI sends (Codex 0.167.0, Gemini CLI 0.67.0,
2026-11-07):

- Codex: `--sandbox read-only` alone still offers `exec_command` (shell; read-only still reads
  every file), `view_image`, `web_search`, `tool_search` and goal tools. The `--disable` features
  (`codex exec --help`: "Equivalent to `-c features.<name>=false`"; names from
  `codex features list`) and `web_search="disabled"` remove them. Codex cannot turn off
  `apply_patch` (enabled by its model catalog, no config switch) or `request_user_input`; neither
  reads files, and the read-only sandbox with approvals `never` refuses every patch.
- Gemini CLI: headless runs offer `read_file`, `list_directory`, `grep_search`, `glob`,
  `google_web_search` and `invoke_agent` by default. A policy file with one rule
  `toolName = "*"`, `decision = "deny"` removes all of them ("tools that are denied are
  completely excluded", [policy engine](https://geminicli.com/docs/reference/policy-engine)); the
  model is offered no tools. `--skip-trust` because headless runs refuse an untrusted folder.
- Claude Code: `--tools ""`, see above; its login is the `CLAUDE_CODE_OAUTH_TOKEN` variable.

**Logins** are files under `/run/secrets/llm-cli` (dev: `./.secrets/llm-cli`, gitignored; prod:
`LLM_CLI_SECRETS_DIR` on the host, mode 600), named per subscription in the config: `env` maps a
variable to the file holding its value, `files` copies a file into the subscription's private
HOME. They are never baked into the image and never logged; each CLI run gets only its own
subscription's environment (not the shim's, so `LLM_CLI_TOKEN` and other logins stay invisible)
and runs in an empty scratch directory outside that HOME. A subscription whose file is missing is skipped.
llm-cli listens only on the internal network and requires `Authorization: Bearer $LLM_CLI_TOKEN`.

**Concurrency and fallback.** Each subscription has its own `concurrency` (default 1). A request
takes the next free subscription of its CLI round-robin; when all are busy it waits in a bounded
FIFO queue (`queue.max`, `queue.timeoutMs`). A subscription that answers rate-limited cools down
for `cooldownMs` and the request moves to the next one. When every subscription is cooling down,
or the queue is full or the wait times out, llm-cli answers 429 with `retry-after`, and the
gateway applies the registry `fallback`. The limits live in the llm-cli process because that
process owns the logins; run one replica (a Temporal task queue per subscription would limit per
worker process, not per subscription, and the eval path would bypass it).

**Terms of use (read before enabling).** Consumer subscriptions are sold for personal use, and
the vendors say so: Anthropic "does not permit third-party developers to offer Claude.ai login
into their own applications, or to route requests through Free, Pro, Max, or Ultra plan
credentials on behalf of their users", and its limits "assume ordinary, individual usage"
([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance));
OpenAI's terms forbid making "your account available to anyone else" and recommend API keys for
automation ([terms](https://openai.com/policies/row-terms-of-use/),
[Codex auth](https://developers.openai.com/codex/auth)); Google calls access to the Gemini CLI
backend through third-party software "grounds for suspension or termination of your account"
([Gemini CLI terms](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)).
Serving many users of your product through one subscription can get that account limited or
closed. The mode stays on by default because pluggability, not price, is the point; for a product
with many users, switch the purpose to an API key, an aggregator or a self-hosted model.

## Organization-owned providers (BYO)

An org admin can add the organization's own provider in Settings -> AI providers (feature flag
`byo-llm-providers`, plan feature `byoLlm`, `POST /api/ai-providers`): one of the `api` /
`aggregator` providers with its own API key, or a `custom` one (`openai_compatible`) with a base
URL (+ optional key), and the model id per purpose. Then:

- **Only providers of the contour.** An org may bring its own key only for a provider that the
  current `AI_CONTOUR` lists (any model entry of it in `config/ai-models.json`): the contour
  decides where data may go, whoever pays. The API refuses others (400) and the worker refuses
  them again at call time (`ProviderBlocked`), e.g. after the operator removes a provider from
  the contour. The shipped `eu` contour lists `anthropic` as its only BYO-able provider; add a
  model entry for `openai`, `openrouter` or `openai_compatible` to let orgs bring those.
- **Behind the flag.** While `byo-llm-providers` is off, the API routes answer 404 and the worker
  ignores stored providers (the operator's models serve every org).

- **Only for that org.** The worker looks it up under the org's RLS scope for each call; another
  org never sees or uses it. While the org has an enabled provider for a purpose and its plan
  includes `byoLlm`, its calls for that purpose go there (`ai_calls.provider` = `byo:<name>`,
  no cost recorded, no plan limits: the org pays its provider). After a downgrade the operator's
  models serve it again. If its provider cannot be used (key unreadable, address refused), the
  call fails with `ProviderBlocked` instead of sending the org's data elsewhere.
- **Encrypted** with the webhook key ring (`WEBHOOK_ENCRYPTION_KEYS`, AES-256-GCM, bound to
  `<org id>/<row id>`, so a copied ciphertext does not decrypt in another row); the API returns
  only the last 4 characters, the worker decrypts at call time, the daily maintenance workflow
  re-encrypts after a key rotation.
- **Audit-logged**: every create/update/delete is an `audit_log` row (`withTenant`).
- **SSRF**: a custom base URL is checked like a webhook target (`worker/webhooks.py`): every
  address of the host must be public, and the connection goes to the checked address with the
  original Host header and TLS SNI, so DNS cannot swap it afterwards. An on-prem model server in
  a private range works only if the operator lists its CIDR in `AI_BYO_ALLOWED_CIDRS`. No
  redirects, no proxy from the environment. Vendor providers use the `baseUrl` of
  `config/ai-models.json`; only the key is the org's.

## On-prem and self-hosted models

| Server                                                    | Use                    | Why                                                                                                                    |
| --------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [vLLM](https://github.com/vllm-project/vllm) (Apache-2.0) | production, many users | "Continuous batching of incoming requests" and PagedAttention for the KV cache: many concurrent requests share one GPU |
| [Ollama](https://github.com/ollama/ollama) (MIT)          | dev, single user       | simple model management; parallelism is a per-model setting with a small default                                       |

Ollama's own FAQ ([faq](https://github.com/ollama/ollama/blob/main/docs/faq.mdx), checked
2026-11-07): "`OLLAMA_NUM_PARALLEL` - The maximum number of parallel requests each model will
process at the same time, default 1. Required RAM will scale by `OLLAMA_NUM_PARALLEL` *
`OLLAMA_CONTEXT_LENGTH`."; further requests queue (`OLLAMA_MAX_QUEUE`, "The default is 512").
vLLM schedules up to `--max-num-seqs` sequences per step (v0.33.0 server default: 256 on GPUs
under 70 GiB, 1024 on larger ones) and keeps adding requests to the running batch, which is what
multi-user serving needs.

Compose: `docker compose --profile local-llm up -d` starts `vllm` (OpenAI-compatible server,
`vllm/vllm-openai:v0.33.0`, all NVIDIA GPUs through the NVIDIA container runtime, default model
`Qwen/Qwen3-0.6B`, `--api-key $VLLM_API_KEY`), `vllm-embed` (`BAAI/bge-small-en-v1.5` with
`--runner pooling`, `/v1/embeddings`) and `ollama`. All publish on 127.0.0.1 only; in production
put them on the internal network without ports. Then `VLLM_BASE_URL=http://vllm:8000/v1` (or
`http://localhost:8000/v1` for a worker on the host) and pick `vllm` / `Qwen/Qwen3-0.6B`.
Without a GPU, `--profile local-llm-cpu` runs `vllm/vllm-openai-cpu:v0.33.0-x86_64`
("`avx512f` (Recommended), `avx2` (Limited features)",
[CPU install](https://docs.vllm.ai/en/latest/getting_started/installation/cpu.html)) for tiny
models and smoke tests only. vLLM's `--api-key` is a shared secret, not an access-control layer
([its docs](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) say not to rely
on it): keep the server off public networks.

**VRAM sizing.** Weights: parameters x bytes per parameter: FP16/BF16 2 bytes, INT8 1, INT4 0.5
("a model with 7 billion parameters ... loaded in 16-bit precision ... would take roughly 7B *
sizeof(FP16) ~= 14 GB", [NVIDIA](https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/);
8-bit and 4-bit figures in [Hugging Face](https://huggingface.co/docs/transformers/llm_tutorial_optimization)).
KV cache per token: 2 x layers x KV heads x head dim x bytes (NVIDIA's formula with KV heads
instead of attention heads for grouped-query attention); times context length times concurrent
sequences. vLLM pre-allocates `--gpu-memory-utilization` of the GPU (v0.33.0 default 0.92; the
compose file sets 0.85 for `vllm` and 0.1 for `vllm-embed`, which share the GPU) and fills what
the weights leave with KV cache, so more VRAM means more concurrent users, not just bigger
models. Rough guide for FP16 weights plus a working KV cache: 0.6-1.5B on any 8 GB GPU; 7-8B on
24 GB (16 GB at INT8/INT4); 32B on 80 GB, or 2 x 48 GB with tensor parallelism; 70B on 2-4 x
80 GB. Measure with your context length and load before buying.

**Multi-GPU.** `--tensor-parallel-size N` splits each layer across N GPUs of one host
([parallelism and scaling](https://docs.vllm.ai/en/latest/serving/parallelism_scaling.html)); add
it to the `vllm` command. For more throughput rather than bigger models, run several replicas
behind one OpenAI-compatible base URL (a second `local` provider entry per replica is enough for
a fallback).

## What is tested how

- Routing per kind: `tests/test_providers.py` sends each provider through LiteLLM to a local HTTP
  mock and checks URL, auth header, model and parsed usage; prices from LiteLLM's map; the BYO
  SSRF guard and IP pinning.
- Gateway: `tests/test_billing.py` (fail-closed pricing, money and calls/tokens limits,
  rate-limit fallback), `tests/test_providers.py` (an unconfigured provider is refused with
  `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` set, no request sent; vendor base URLs explicit),
  `tests/test_byo.py` (encryption bound to org and row, isolation between orgs, plan feature,
  contour, flag on/off, refused private address), `apps/api/test/billing.test.ts` (BYO API:
  contour, flag on/off).
- llm-cli: `services/llm-cli/test/` with a fake CLI binary (adapters and their tool-off flags,
  prompt on stdin, environment isolation, timeouts, concurrency, round-robin, cooldown, queue, HTTP
  format).
- `pnpm eval:real` runs the product prompts on the model the eval config names and grades them
  with `claude_cli:claude-opus-5-5` through the logged-in Claude CLI (same adapter as llm-cli).
