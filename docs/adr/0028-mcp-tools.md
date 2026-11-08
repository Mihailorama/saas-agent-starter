# 0028. External MCP tools in the AI gateway

Status: accepted

## Context

Products built on the starter want AI features that act on a customer's own systems (search
their docs, look up a ticket). MCP is the common protocol for that, and organizations already
run or buy MCP servers. Owner rules: every LLM call stays in `Gateway.call_llm`, the model is
explicit, no content in logs, spans or workflow arguments, `ai_calls` is the record; every
external service is both "connect your own" and "install" (a compose profile); reuse installed
libraries; never write a protocol client ourselves.

## Decision

- **Client: the official `mcp` Python SDK (MIT), through LiteLLM's `mcp` extra.** LiteLLM (already
  the provider layer, ADR 0024) ships `litellm.experimental_mcp_client`; we use its
  `load_mcp_tools` to list a session's tools and convert them to OpenAI tool definitions, and
  `call_openai_tool` for calls (it turns invalid JSON arguments into `{}`; the server's input
  validation then answers with an error the model sees). Installing
  `litellm[mcp]` adds `mcp` 2.3.0 and its dependencies (all permissive, `pnpm check:licenses`
  unchanged); nothing from LiteLLM's proxy or enterprise packages.
- **Transport: Streamable HTTP only, one short-lived session per use** (one to list, one per
  tool call), through our own `httpx2` client with the BYO `PinnedTransport`: the host is checked
  with `resolve_public` (private, loopback, link-local and metadata addresses refused unless in
  `MCP_ALLOWED_CIDRS`) each time, and the session connects only to the checked address. A
  long-lived session's transport runs in an anyio task group: when the server dies, the group
  cancels the caller, which aborted the whole call with no record. Per-call sessions turn that
  into an ordinary exception of one tool call (row, error back to the model), at the cost of an
  `initialize` round trip per call. stdio servers would run arbitrary commands in the worker;
  not offered.
- **Opt-in per call** (`mcp_tools=True`), behind the flag `mcp-tools`. A call without it is
  byte-for-byte the previous behaviour, so no existing purpose changes.
- **Bounded loop in the gateway**: at most `MCP_TOOL_MAX_ITERATIONS` model turns, the last one
  with no tools offered so the model must answer (LiteLLM adds the dummy tool Anthropic needs
  when the history holds tool calls); a model that asks anyway fails non-retryably
  (`ToolLoopLimit`). Each session has `MCP_TOOL_TIMEOUT_SECONDS`, results are cut at 20 000
  characters for the model. Tool failures go back to the model, so they never retry the
  activity; a retry for another reason re-runs the loop (at-least-once tool calls, docs/mcp.md).
- **Per-purpose reach**: `mcp_servers.purposes` lists the AI purposes that may use a server, and
  the gateway offers a call only the servers of its own purpose. A model reading untrusted input
  (a support ticket) can be steered by it; scoping by purpose keeps that injection away from the
  tools of other features. A column per server, not per tool: the unit an admin trusts is the
  server and its token, and `allowed_tools` already narrows within it; a purpose x tool matrix
  would be a second allow-list to keep in sync.
- **Every tool call is an `ai_calls` row** (`provider` `mcp:<server>`, `request_model` = tool),
  arguments and result in S3 like prompts. No new column: `ai_calls` stays append-only and the
  AI calls page shows tool calls without changes; the S3 request names the parent model call.
  A model-chosen name that was not offered is content until checked, so it is recorded as
  `unknown` in the row and span and kept only in S3.
- **Per-organization servers** in a tenant table `mcp_servers` (RLS, at most 10 per org), with
  the purposes, the allow-list of tool names and an auth header whose value is encrypted like BYO
  keys and re-encrypted by the same key-rotation schedule. Changing the URL or header needs the
  value again (BYO base URLs too), so a stored secret cannot be redirected. Admin API with scopes
  `mcp_servers:read` / `:write`.
- **Install variant**: the `mcp` compose profile runs the MCP project's reference
  `server-everything` (MIT / Apache-2.0) unmodified via `npx` in the `node` image, pinned to a
  version. There is no maintained official container image of it (Docker Hub's `mcp/everything`
  was last built in May 2025, before the current protocol revision).

## Consequences

- Tool use works with providers that support OpenAI-style tool calling; the vendor CLI
  subscriptions (`llm-cli`) do not, so a tool-using purpose needs an API, aggregator, custom or
  local model.
- A failing server removes only its tools; one that dies mid-loop fails only its tool calls.
- The settings page cannot list a server's tools (the API never connects out); admins type the
  names. OAuth-protected servers, prompts/resources/sampling and A2A are not covered.
- `pnpm check` needs the `mcp` profile running for the worker tests; CI starts it.
