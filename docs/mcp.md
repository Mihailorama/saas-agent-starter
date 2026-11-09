# MCP (Model Context Protocol)

The product speaks MCP in both directions, each documented in its own section:

- [MCP server (for customers' AI agents)](#mcp-server-for-customers-ai-agents): agents use the
  product through `/mcp` (ADR 0027).
- [Calling external tools](#calling-external-tools): the product's own AI features call tools on
  MCP servers an organization connects (ADR 0028).

## MCP server (for customers' AI agents)

Customers' AI agents (Claude, ChatGPT, Gemini, Cursor, any MCP client) use the product through
the [Model Context Protocol](https://modelcontextprotocol.io). The endpoint is
`https://<app domain>/mcp`, authenticated with an **organization API key** (docs/public-api.md).
It adds a way in; every existing path stays as it is. Design: [ADR 0027](adr/0027-mcp-server.md).

### The two variants

|                | Install (ships in the API)                                                        | Connect your own (customer side)                                 |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| What           | `/mcp` on the Fastify API (`apps/api/src/routes/mcp.ts`), nothing extra to run    | The customer's MCP client is pointed at the URL with a key       |
| Who sets it up | The operator: turn on the `mcp-server` flag (below)                               | An org admin: creates a key, pastes URL + key into the client    |
| Transport      | Streamable HTTP, stateless; spec 2026-07-28, plus the 2025-era stateless fallback | Any client that speaks Streamable HTTP and sends a bearer header |
| Scale          | Any API replica answers any request: no sessions, no sticky routing               | -                                                                |

#### Install: turn it on

The endpoint is in every API build behind the feature flag `mcp-server` (config/flags.json,
default off). While it is off, `/mcp` answers 404 to a valid key; a request without a valid key gets 401
either way (the key is checked first, so the flag can be rolled out per organization).

- One environment: `FLAGS_ON=mcp-server` (API env; forwarded in compose.prod.yaml).
- Gradual: `pnpm flags:sync`, then roll it out in PostHog per organization (the flag is evaluated
  with the key's org as the `organization` group, docs/feature-flags.md).

No new env vars. The web origin proxies `/mcp` to the API like `/api` (Vite in dev,
`apps/web/nginx.conf.template` in the image), so the public URL is the app's own domain.

#### Connect your own: point a client at it

1. Settings -> API keys: create a key with the scopes the agent needs (`projects:read` for the
   read tools, add `projects:write` to let it create projects). Prefer an expiry.
2. Give the client the URL and the header `Authorization: Bearer sk_...`.

Ready config for clients that read an `mcpServers` JSON (Claude Desktop/Code, Cursor, Gemini
CLI and others; the key name for the URL varies by client, `url` or `httpUrl`):

```json
{
  "mcpServers": {
    "workspace": {
      "type": "http",
      "url": "https://app.example.com/mcp",
      "headers": { "Authorization": "Bearer ${WORKSPACE_API_KEY}" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http workspace https://app.example.com/mcp --header
"Authorization: Bearer $WORKSPACE_API_KEY"`.

Hosted assistants (ChatGPT connectors, claude.ai custom connectors) mostly expect OAuth instead
of a pasted header; that is not built yet (docs/TODO.md). Until then use them through a client
that can send the header.

### Tools

| Tool             | Scope            | Same as                                               |
| ---------------- | ---------------- | ----------------------------------------------------- |
| `list_projects`  | `projects:read`  | `GET /api/projects` (result as `{ projects: [...] }`) |
| `get_project`    | `projects:read`  | `GET /api/projects/{id}`                              |
| `create_project` | `projects:write` | `POST /api/projects`                                  |

`tools/list` shows only the tools the key's scopes cover. Each tool calls the REST route it
mirrors in-process with the caller's key, so everything is the route's own behaviour: Zod input
schema, scope check, plan limit, the tenant's RLS transaction (`withTenant`), the `audit_log` row
(`POST /api/projects` by `apikey:<id>`), the `project.created` webhook event and the per-key rate
limit. A project of another organization is "Not Found", exactly as over REST. A failed call
comes back as a tool result with `isError: true` and the route's error text.

### Security

- **API keys only.** No session cookies: a browser session cannot drive an agent. No key, a bad
  key or a revoked one is 401 with `WWW-Authenticate: Bearer`; a suspended org is 403.
- **Rate limit.** `/mcp` has its own per-key limit (`API_KEY_RATE_LIMIT_PER_MINUTE`); each tool
  call also counts once against the REST limit of the same key.
- **Logs.** One line per tool call with the tool name (`mcpTool`) and the usual request ids;
  never arguments or results.
- An agent can be steered by content it reads (prompt injection). Give its key the narrowest
  scopes and an expiry; writes stay audited per key.

### Add a tool

Recipe in AGENTS.md, "Recipe: expose a tool over MCP".

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
