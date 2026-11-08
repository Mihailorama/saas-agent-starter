"""External MCP tools for the AI gateway (docs/mcp.md "Calling external tools", ADR 0028).

An organization connects remote MCP servers (`mcp_servers`: URL, the purposes that may use it,
allowed tool names, an encrypted auth header). For a call that opts in, the gateway lists the
tools of the servers its purpose may use with the official `mcp` SDK (Streamable HTTP) and
LiteLLM's MCP helpers, and offers the model only the allowed ones. Every session is short-lived:
one to list, one per tool call, so a server that fails is an ordinary error of that one call.
Each session checks the URL again (`resolve_public`, the BYO SSRF guard) and connects only to
the checked address (`PinnedTransport`), so DNS cannot move a tool call to a private address.
"""

import asyncio
import json
import logging
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, cast
from urllib.parse import urlsplit

import anyio
import asyncpg
import httpx2
from litellm.experimental_mcp_client import call_openai_tool, load_mcp_tools
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from worker.providers import BlockedEndpoint, Network, PinnedTransport, ToolCall, ToolSpec
from worker.webhooks import decrypt_secret, resolve_public

log = logging.getLogger(__name__)

# ponytail: fixed caps; make them settings if an org needs more.
MAX_RESULT_CHARS = 20_000  # what one tool result adds to the model's context
MAX_SERVERS = 10  # servers listed per call (the API refuses more per org)


@dataclass(frozen=True)
class McpConfig:
    keys: Mapping[str, bytes]  # WEBHOOK_ENCRYPTION_KEYS: decrypts the auth header values
    allowed_networks: Sequence[Network] = ()  # MCP_ALLOWED_CIDRS
    max_iterations: int = 5  # model turns per call_llm; the last one gets no tools
    timeout: float = 30.0  # seconds per session (listing, or one tool call)


@dataclass(frozen=True)
class Server:
    id: str
    name: str
    url: str
    headers: Mapping[str, str]
    allowed: frozenset[str]  # tool names the org allows


@dataclass(frozen=True)
class ToolResult:
    text: str  # what the model sees
    content: Any  # the full MCP result, stored in S3
    is_error: bool


@asynccontextmanager
async def session(server: Server, cfg: McpConfig) -> AsyncGenerator[ClientSession]:
    """One initialized session; the URL is checked and pinned each time."""
    parts = urlsplit(server.url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username:
        raise BlockedEndpoint("invalid URL")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        ip = await resolve_public(parts.hostname, port, cfg.allowed_networks)
    except Exception as err:  # BlockedAddress or DNS failure
        raise BlockedEndpoint(f"server host is not allowed ({type(err).__name__})") from err
    # fail_after outside the transport's task group: a failed transport task surfaces here as
    # the real error, not as a cancellation of the caller.
    with anyio.fail_after(cfg.timeout):
        async with (
            httpx2.AsyncClient(
                transport=PinnedTransport(ip),
                headers=dict(server.headers),
                trust_env=False,  # no proxy from the environment: we connect to the checked IP
                timeout=cfg.timeout,
            ) as http,
            streamable_http_client(server.url, http_client=http) as (read, write),
            ClientSession(read, write) as s,
        ):
            await s.initialize()
            yield s


@dataclass
class Toolbox:
    """The tools one call may use: OpenAI specs for the model, and the server behind each."""

    cfg: McpConfig
    specs: list[ToolSpec] = field(default_factory=list[ToolSpec])
    servers: dict[str, Server] = field(default_factory=dict[str, Server])  # tool -> server

    async def call(self, call: ToolCall) -> ToolResult:
        async with session(self.servers[call.name], self.cfg) as s:
            res = await call_openai_tool(
                s,
                cast(
                    Any,
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {"name": call.name, "arguments": call.arguments},
                    },
                ),
            )
        parts = [
            c.text if c.type == "text" else json.dumps(c.model_dump(mode="json"))
            for c in res.content
        ]
        return ToolResult(
            "\n".join(parts)[:MAX_RESULT_CHARS], res.model_dump(mode="json"), res.is_error
        )


async def _list(server: Server, cfg: McpConfig) -> list[ToolSpec]:
    try:
        async with session(server, cfg) as s:
            return cast(list[ToolSpec], await load_mcp_tools(s, format="openai"))
    except Exception as err:  # blocked, unreachable, not MCP: its tools are simply not offered
        log.warning("MCP server %s unusable: %s", server.id, type(err).__name__)
        return []


async def toolbox(pool: asyncpg.Pool, org_id: str, purpose: str, cfg: McpConfig) -> Toolbox:
    """The allowed tools of the org's enabled servers that list `purpose`, listed concurrently.
    A server whose secret cannot be decrypted is left out like an unreachable one."""
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        rows = await conn.fetch(
            "select id::text as id, name, url, allowed_tools, auth_header, auth_secret"
            " from mcp_servers where enabled and $1 = any(purposes)"
            " and cardinality(allowed_tools) > 0 order by created_at limit $2",
            purpose,
            MAX_SERVERS,
        )
    servers: list[Server] = []
    for r in rows:
        headers: dict[str, str] = {}
        if r["auth_header"] and r["auth_secret"]:
            try:  # bound like BYO keys (apps/api/src/routes/mcp-servers.ts)
                secret = decrypt_secret(r["auth_secret"], f"{org_id}/{r['id']}", cfg.keys)
            except Exception as err:
                log.warning("MCP server %s unusable: %s", r["id"], type(err).__name__)
                continue
            headers[r["auth_header"]] = secret
        servers.append(Server(r["id"], r["name"], r["url"], headers, frozenset(r["allowed_tools"])))
    box = Toolbox(cfg)
    listed = await asyncio.gather(*(_list(s, cfg) for s in servers))
    for server, specs in zip(servers, listed, strict=True):
        for spec in specs:
            name = str(spec["function"]["name"])
            # ponytail: first server wins a duplicate tool name; prefix names if orgs hit it.
            if name in server.allowed and name not in box.servers:
                box.specs.append(spec)
                box.servers[name] = server
    return box
