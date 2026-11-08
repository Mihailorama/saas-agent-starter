# 0026. External MCP tools in the AI gateway

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
  `load_mcp_tools` to list a session's tools and convert them to OpenAI tool definitions, and the
  SDK's `ClientSession.call_tool` for calls (LiteLLM's `call_openai_tool` silently turns invalid
  JSON arguments into `{}`; we want that to be an error the model sees). Installing
  `litellm[mcp]` adds `mcp` 2.3.0 and its dependencies (all permissive, `pnpm check:licenses`
  unchanged); nothing from LiteLLM's proxy or enterprise packages.
- **Transport: Streamable HTTP only**, through our own `httpx2` client with the BYO
  `PinnedTransport`: the server host is checked with `resolve_public` (private, loopback,
  link-local and metadata addresses refused unless in `MCP_ALLOWED_CIDRS`) when the session opens,
  and every request of the session goes to the checked address. stdio servers would run
  arbitrary commands in the worker; not offered.
- **Opt-in per call** (`mcp_tools=True`), behind the flag `mcp-tools`. A call without it is
  byte-for-byte the previous behaviour, so no existing purpose changes.
- **Bounded loop in the gateway**: at most `MCP_TOOL_MAX_ITERATIONS` model turns ask for tools,
  each tool call and session start has `MCP_TOOL_TIMEOUT_SECONDS`, results are cut at 20 000
  characters for the model. Over the cap the call fails non-retryably (`ToolLoopLimit`) rather
  than sending a tool-less final request that some providers reject when the history holds tool
  calls.
- **Every tool call is an `ai_calls` row** (`provider` `mcp:<server>`, `request_model` = tool),
  arguments and result in S3 like prompts. No new column: `ai_calls` stays append-only and the
  AI calls page shows tool calls without changes; the S3 request names the parent model call.
  A model-chosen name that was not offered is content until checked, so it is recorded as
  `unknown` in the row and span and kept only in S3.
- **Per-organization servers** in a tenant table `mcp_servers` (RLS), with the allow-list of tool
  names and an auth header whose value is encrypted like BYO keys and re-encrypted by the same
  key-rotation schedule. Admin API with scopes `mcp_servers:read` / `:write`.
- **Install variant**: the `mcp` compose profile runs the MCP project's reference
  `server-everything` (MIT / Apache-2.0) unmodified via `npx` in the `node` image, pinned to a
  version. There is no maintained official container image of it (Docker Hub's `mcp/everything`
  was last built in May 2025, before the current protocol revision).

## Consequences

- Tool use works with providers that support OpenAI-style tool calling; the vendor CLI
  subscriptions (`llm-cli`) do not, so a tool-using purpose needs an API, aggregator, custom or
  local model.
- A failing server removes only its tools; a server that dies in the middle of a loop fails the
  activity (Temporal retries it).
- The settings page cannot list a server's tools (the API never connects out); admins type the
  names. OAuth-protected servers, prompts/resources/sampling and A2A are not covered.
- `pnpm check` needs the `mcp` profile running for the worker tests; CI starts it.
