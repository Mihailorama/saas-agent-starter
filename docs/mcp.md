# MCP (Model Context Protocol)

## Calling external tools

An AI purpose can let the model call tools on remote MCP servers that an organization connects.
Why it is built this way: [ADR 0028](adr/0028-mcp-tools.md).

### How it works

1. An org admin connects a server in **Settings → MCP servers** (`/settings/mcp-servers`, API
   `POST /api/mcp-servers`, scopes `mcp_servers:read` / `mcp_servers:write`): a name, the server
   URL (Streamable HTTP endpoint, usually `.../mcp`), the **AI features (purposes) that may use
   it**, the **allowed tool names**, and optionally an auth header (name + value, e.g.
   `Authorization: Bearer ...`). The value is encrypted at once with `WEBHOOK_ENCRYPTION_KEYS`,
   bound to the organization and row, and never shown again; changing the URL or the header
   needs the value again, so a stored secret cannot be redirected to another host. At most 10
   servers per organization. The API never connects to the URL.
2. A purpose opts in per call: `gateway.call_llm(..., mcp_tools=True)`. Without it, or with the
   flag `mcp-tools` off for the organization, or without `WEBHOOK_ENCRYPTION_KEYS` on the worker,
   the call is exactly a plain call (no tools, same request and response objects).
3. The gateway (`services/worker-py/worker/mcp.py`) takes the enabled servers whose purposes
   include the call's purpose and that allow at least one tool, lists their tools concurrently
   with the official `mcp` Python SDK and LiteLLM's `load_mcp_tools`, and offers the model only
   the allowed ones. A server that is blocked, unreachable or whose secret cannot be decrypted
   is left out (logged by id and error class); the call goes on without its tools.
4. Tool loop: at most `MCP_TOOL_MAX_ITERATIONS` model turns (default 5); the last one offers no
   tools, so the model answers with what it has (one that asks anyway ends the call with
   `ToolLoopLimit`, non-retryable). Every tool call opens its own short session (URL checked
   again) with `MCP_TOOL_TIMEOUT_SECONDS` (default 30, also for listing) and calls the tool with
   LiteLLM's `call_openai_tool`. Any failure, a server that went away mid-loop included, goes
   back to the model as `tool error: <class>` and gets its row; a tool the call did not offer
   is never called (`ToolNotOffered`). Results longer than 20 000 characters are cut for the
   model (stored whole).
5. Retries: a tool failure never fails the activity. If the activity fails for another reason
   (worker crash, provider error, limit) and Temporal retries it, the whole loop runs again,
   earlier tools included: tool calls are **at least once**. Give side-effecting tools
   idempotent semantics on the server, or leave them out of `allowed_tools`.

### What is recorded

- Every model turn is an `ai_calls` row as before (limits, cost, fallback, BYO all apply per
  turn); its S3 request carries the offered tool definitions, its response the tool calls.
- Every tool call is its own `ai_calls` row: `provider` = `mcp:<server name>` (`mcp` for a tool
  that was not offered), `request_model` = tool name (`unknown` if not offered),
  `prompt_template_id` = `mcp.tool`, `status` `ok` or `error` (`error_class` e.g.
  `ToolNotOffered`, `TimeoutError`, `ToolResultError` when the server reports an error). The
  arguments and the full result are S3 objects (`request_key`, `response_key`) with the parent
  model call's id, deleted with the other AI content after `AI_CONTENT_RETENTION_DAYS`.
- One trace per loop (`invoke_agent <purpose>`), with a `chat` span per turn and an
  `execute_tool <tool>` span per tool call; no arguments or results in spans or logs.
- Metrics: the existing `ai_calls_total` / latency / cost series count model turns only; tool
  calls are `ai_tool_calls_total{purpose, status}`.
- `pnpm eval:pull` skips tool rows.

### Connect your own server

Any remote MCP server that speaks Streamable HTTP:

1. Turn on the flag for the organization (`pnpm flags:sync`, then PostHog; locally
   `FLAGS_ON=mcp-tools` for API and worker, `VITE_FLAGS_ON=mcp-tools` for the web).
2. Settings → MCP servers → Connect server: URL `https://mcp.example.com/mcp`, the AI features
   that may use it, the tools they may call, and its token as `Authorization` /
   `Bearer <token>`. Each server reaches only the purposes listed: a prompt injection in one
   feature's input cannot reach another feature's tools.
3. The URL must resolve to public addresses only: the worker checks every address of the host
   when it opens the session and connects to the checked address (same guard as BYO base URLs,
   so DNS cannot switch to a private address between check and connect). For an on-prem server
   in a private range, list its CIDR in `MCP_ALLOWED_CIDRS`; never broad private ranges in a
   multi-tenant deployment.

### Install the reference server (local dev and tests)

The `mcp` compose profile runs the MCP project's reference server, `server-everything`
(MIT / Apache-2.0), unmodified, in the `node` image (fetched from npm at start, version pinned):

```sh
docker compose --profile mcp up -d --wait mcp-server   # http://localhost:${MCP_SERVER_PORT:-3600}/mcp
```

It offers test tools such as `echo`, `get-sum` and `get-env` (the last one shows why the allow-list
matters). Connect it as `http://127.0.0.1:3600/mcp` with a worker on the host and
`MCP_ALLOWED_CIDRS=127.0.0.0/8`, or as `http://mcp-server:3001/mcp` with the worker in compose and
`MCP_ALLOWED_CIDRS` set to the compose network's range. Use `127.0.0.1`, not `localhost`: the
guard connects to the first address the name resolves to, which can be `::1`. The worker tests
(`services/worker-py/tests/test_mcp.py`) need it running.

### Which providers support tools

The loop needs a model endpoint with OpenAI-style tool calling: API keys, aggregators, custom
OpenAI-compatible endpoints and local servers (vLLM with a tool-call parser, Ollama) through
LiteLLM. The vendor CLI subscriptions of the `llm-cli` container run without tools
(docs/llm-providers.md), so a tool-using purpose needs one of the other kinds.

### Not covered (yet)

- Picking tools from the server's list in the settings page: the API never talks to the server,
  so admins type the names. A "test connection" would be a worker workflow.
- stdio servers and OAuth-protected servers (only a static auth header).
- Prompts, resources, sampling and elicitation from servers: tools only.
- A2A (agent-to-agent) is deferred.
