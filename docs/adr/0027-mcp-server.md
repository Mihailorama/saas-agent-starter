# 0027. MCP server for organization API keys

Status: accepted (owner decision, 2026-11-08: customers' AI agents use the product through MCP;
library picks after research on 2026-11-08)

## Context

Customers want their AI agents (Claude, ChatGPT, Gemini, Cursor) to work with the product. MCP
is the protocol those clients share. The public API already has organization API keys with scopes,
per-key rate limits, RLS tenancy and audit (ADR 0018); an MCP endpoint should reuse all of it and
add no second authorization model. Usage: [docs/mcp.md](../mcp.md).

## Decision

- **Library: `@modelcontextprotocol/server` 2.x** (official TypeScript SDK v2, Apache-2.0, zod 4
  only, implements spec 2026-07-28). `createMcpHandler(factory)` is a web-standard
  `fetch(Request) -> Response` handler; the Fastify route builds the `Request` (as the Better
  Auth handler in app.ts does) and sends the `Response`. Not v1 `@modelcontextprotocol/sdk`: it
  pulls Express and Hono.
- **Not `@modelcontextprotocol/fastify`.** It was on the shortlist, but it contains only Host and
  Origin validation hooks for servers bound to localhost (DNS rebinding). `/mcp` is a public,
  bearer-only endpoint behind the app's own Origin check, so nothing in it would be used. The SDK
  docs suggest `@modelcontextprotocol/node` for Node frameworks; `fetch` makes that unnecessary.
- **Transport: Streamable HTTP at `/mcp`, stateless.** The 2026-07-28 era is per-request; 2025-era
  clients get the SDK's stateless fallback (`legacy: 'stateless'`, the default), since most
  clients do not speak 2026-07-28 yet. No session store, any replica serves any request.
- **Auth: organization API keys as `Authorization: Bearer`, nothing else.** `verifiedKey()` in
  tenant.ts (split out of `requireScope`) checks the key and the org's suspension. Session
  cookies are not accepted.
- **Tools are the REST routes.** A tool calls the route it mirrors with `app.inject` and the
  caller's key. Scope checks, entitlements, `withTenant`/RLS, audit rows, webhook events and
  rate limits are therefore the route's own code: no new authorization or audit logic, and a
  tool cannot drift from its route. Cost: one in-process request per tool call (no network).
  `tools/list` hides tools the key's scopes do not cover; enforcement stays in the route.
- **Behind the `mcp-server` flag** (default off): 404 while off. Evaluated after the key is known,
  so it can be rolled out per organization; an unauthenticated request gets 401 either way.
- **First tools: list/get/create project.** Create needs no extra design because it is the REST
  route (plan limit, audit, event, workflow start included).

## Deferred

- **OAuth 2.1 for MCP** (hosted connectors in ChatGPT/claude.ai expect it): `@better-auth/mcp`
  (MIT, same release line as our Better Auth) is an OAuth 2.1 authorization server with RFC 9728
  metadata on top of `@better-auth/oauth-provider`. Open: login/consent pages, picking the
  organization at consent (tokens are per user, keys per org) and mapping OAuth scopes to
  `SCOPES`. docs/TODO.md.
- `subscriptions/listen` (change notifications): needs a shared event bus across replicas; no
  tool needs it yet.
- A2A, AP2, UCP: docs/TODO.md.

## Consequences

- One more public entry point; it is covered by the same tests as the REST routes plus
  `apps/api/test/mcp.test.ts` (official MCP client on both eras, flag, auth, scopes, cross-org).
- Adding a tool is a few lines next to an existing route (AGENTS.md recipe).
