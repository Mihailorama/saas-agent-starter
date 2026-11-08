# MCP server (for customers' AI agents)

Customers' AI agents (Claude, ChatGPT, Gemini, Cursor, any MCP client) use the product through
the [Model Context Protocol](https://modelcontextprotocol.io). The endpoint is
`https://<app domain>/mcp`, authenticated with an **organization API key** (docs/public-api.md).
It adds a way in; every existing path stays as it is. Design: [ADR 0027](adr/0027-mcp-server.md).

## The two variants

|                | Install (ships in the API)                                                        | Connect your own (customer side)                                 |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| What           | `/mcp` on the Fastify API (`apps/api/src/routes/mcp.ts`), nothing extra to run    | The customer's MCP client is pointed at the URL with a key       |
| Who sets it up | The operator: turn on the `mcp-server` flag (below)                               | An org admin: creates a key, pastes URL + key into the client    |
| Transport      | Streamable HTTP, stateless; spec 2026-07-28, plus the 2025-era stateless fallback | Any client that speaks Streamable HTTP and sends a bearer header |
| Scale          | Any API replica answers any request: no sessions, no sticky routing               | -                                                                |

### Install: turn it on

The endpoint is in every API build behind the feature flag `mcp-server` (config/flags.json,
default off). While it is off, `/mcp` answers 404 to a valid key; a request without a valid key gets 401
either way (the key is checked first, so the flag can be rolled out per organization).

- One environment: `FLAGS_ON=mcp-server` (API env; forwarded in compose.prod.yaml).
- Gradual: `pnpm flags:sync`, then roll it out in PostHog per organization (the flag is evaluated
  with the key's org as the `organization` group, docs/feature-flags.md).

No new env vars. The web origin proxies `/mcp` to the API like `/api` (Vite in dev,
`apps/web/nginx.conf.template` in the image), so the public URL is the app's own domain.

### Connect your own: point a client at it

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

## Tools

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

## Security

- **API keys only.** No session cookies: a browser session cannot drive an agent. No key, a bad
  key or a revoked one is 401 with `WWW-Authenticate: Bearer`; a suspended org is 403.
- **Rate limit.** `/mcp` has its own per-key limit (`API_KEY_RATE_LIMIT_PER_MINUTE`); each tool
  call also counts once against the REST limit of the same key.
- **Logs.** One line per tool call with the tool name (`mcpTool`) and the usual request ids;
  never arguments or results.
- An agent can be steered by content it reads (prompt injection). Give its key the narrowest
  scopes and an expiry; writes stay audited per key.

## Add a tool

Recipe in AGENTS.md, "Recipe: expose a tool over MCP".
