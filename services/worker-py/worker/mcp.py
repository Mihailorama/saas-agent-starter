"""External MCP tools for the AI gateway (docs/mcp.md "Calling external tools", ADR 0026).

An organization connects remote MCP servers (`mcp_servers`: URL, allowed tool names, an
encrypted auth header). For a call that opts in, the gateway opens one session per enabled
server through the official `mcp` SDK (Streamable HTTP) and offers the model only the allowed
tools; LiteLLM's `load_mcp_tools` lists and converts them, calls go through the SDK session.
Every server URL passes the BYO SSRF check (`resolve_public`) when the session opens, and every
request of that session goes to the checked address (`PinnedTransport`), so DNS cannot move a
tool call to a private address.
"""

import json
import logging
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, cast
from urllib.parse import urlsplit

import anyio
import asyncpg
import httpx2
from litellm.experimental_mcp_client import load_mcp_tools
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from worker.providers import BlockedEndpoint, Network, PinnedTransport, ToolCall, ToolSpec
from worker.webhooks import decrypt_secret, resolve_public

log = logging.getLogger(__name__)

# ponytail: fixed cap on what one tool result adds to the context; make it per server if needed.
MAX_RESULT_CHARS = 20_000


@dataclass(frozen=True)
class McpConfig:
    keys: Mapping[str, bytes]  # WEBHOOK_ENCRYPTION_KEYS: decrypts the auth header values
    allowed_networks: Sequence[Network] = ()  # MCP_ALLOWED_CIDRS
    max_iterations: int = 5  # model turns that may ask for tools in one call_llm
    timeout: float = 30.0  # seconds, per session start and per tool call


@dataclass(frozen=True)
class ToolResult:
    text: str  # what the model sees
    content: Any  # the full MCP result, stored in S3
    is_error: bool


@dataclass
class Toolbox:
    """The tools one call may use: OpenAI specs for the model, and the session behind each."""

    timeout: float
    specs: list[ToolSpec] = field(default_factory=list[ToolSpec])
    servers: dict[str, tuple[str, str, ClientSession]] = field(
        default_factory=dict[str, tuple[str, str, ClientSession]]
    )  # tool name -> (server id, server name, session)

    async def call(self, call: ToolCall) -> ToolResult:
        _, _, session = self.servers[call.name]
        arguments = json.loads(call.arguments or "{}")  # invalid JSON: an error for the model
        if not isinstance(arguments, dict):
            raise ValueError("tool arguments must be a JSON object")
        with anyio.fail_after(self.timeout):
            res = await session.call_tool(call.name, cast(dict[str, Any], arguments))
        parts = [
            c.text if c.type == "text" else json.dumps(c.model_dump(mode="json"))
            for c in res.content
        ]
        return ToolResult(
            "\n".join(parts)[:MAX_RESULT_CHARS], res.model_dump(mode="json"), res.is_error
        )


async def servers(pool: asyncpg.Pool, org_id: str) -> list[asyncpg.Record]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch(
            "select id::text as id, name, url, allowed_tools, auth_header, auth_secret"
            " from mcp_servers where enabled order by created_at"
        )


async def _session(
    stack: AsyncExitStack, row: asyncpg.Record, org_id: str, cfg: McpConfig
) -> ClientSession:
    url = str(row["url"])
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username:
        raise BlockedEndpoint("invalid URL")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        ip = await resolve_public(parts.hostname, port, cfg.allowed_networks)
    except Exception as err:  # BlockedAddress or DNS failure
        raise BlockedEndpoint(f"server host is not allowed ({type(err).__name__})") from err
    headers: dict[str, str] = {}
    if row["auth_header"] and row["auth_secret"]:
        aad = f"{org_id}/{row['id']}"  # bound like BYO keys (apps/api/src/routes/mcp-servers.ts)
        headers[row["auth_header"]] = decrypt_secret(row["auth_secret"], aad, cfg.keys)
    http = await stack.enter_async_context(
        httpx2.AsyncClient(
            transport=PinnedTransport(ip),
            headers=headers,
            trust_env=False,  # no proxy from the environment: we connect to the checked IP
            timeout=cfg.timeout,
        )
    )
    read, write = await stack.enter_async_context(streamable_http_client(url, http_client=http))
    return await stack.enter_async_context(ClientSession(read, write))


@asynccontextmanager
async def toolbox(pool: asyncpg.Pool, org_id: str, cfg: McpConfig) -> AsyncGenerator[Toolbox]:
    """Sessions to the org's enabled servers, closed on exit. A server that is blocked or does
    not answer is left out (logged by id and error class); its tools are simply not offered."""
    box = Toolbox(cfg.timeout)
    async with AsyncExitStack() as stack:
        for row in await servers(pool, org_id):
            allowed = set(row["allowed_tools"])
            inner = AsyncExitStack()
            try:
                try:
                    session = await _session(inner, row, org_id, cfg)
                    # Inside the session's task group: anyio cancel scopes must nest.
                    with anyio.fail_after(cfg.timeout):
                        await session.initialize()
                        specs = cast(list[ToolSpec], await load_mcp_tools(session, format="openai"))
                except BaseException as err:
                    # A failed transport task cancels us through its task group; closing the
                    # group turns that into the real error. An outside cancellation re-raises.
                    if not await inner.__aexit__(type(err), err, err.__traceback__):
                        raise
                    raise ConnectionError("MCP session closed") from err
            except Exception as err:
                log.warning(
                    "org %s: MCP server %s unusable: %s", org_id, row["id"], type(err).__name__
                )
                continue
            stack.push_async_exit(inner)
            for spec in specs:
                name = str(spec["function"]["name"])
                # ponytail: first server wins a duplicate tool name; prefix names if orgs hit it.
                if name in allowed and name not in box.servers:
                    box.specs.append(spec)
                    box.servers[name] = (row["id"], row["name"], session)
        yield box
