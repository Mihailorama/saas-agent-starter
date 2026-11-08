"""External MCP tools through the gateway: a fake model provider, a real MCP server.

Needs the reference server of the `mcp` compose profile (docker compose --profile mcp up -d
mcp-server) on localhost:MCP_SERVER_PORT, plus Postgres, S3 and Temporal.
"""

import json
import os
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import timedelta
from ipaddress import ip_network
from typing import Any

import asyncpg
import pytest
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from tests.conftest import new_org
from worker import settings
from worker.ai import AllowedModel, Completion, Gateway, Message, ToolLoopLimit
from worker.mcp import McpConfig
from worker.providers import ToolCall, ToolSpec
from worker.s3 import S3
from worker.webhooks import encrypt_secret, parse_keys

SERVER = f"http://127.0.0.1:{os.environ.get('MCP_SERVER_PORT', '3001')}/mcp"
KEYS = parse_keys("local-dev:local-dev-mcp-test-encryption-key-0123456789")
KEY_ID, KEY = next(iter(KEYS.items()))
LOOPBACK = [ip_network("127.0.0.0/8"), ip_network("::1/128")]


@dataclass
class Script:
    """A fake model: answers with the scripted completions in order, records what it saw."""

    answers: list[Completion]
    seen: list[tuple[list[Message], list[ToolSpec]]] = field(
        default_factory=list[tuple[list[Message], list[ToolSpec]]]
    )

    async def __call__(
        self,
        model: str,
        messages: Sequence[Message],
        max_tokens: int,
        tools: Sequence[ToolSpec] = (),
        /,
    ) -> Completion:
        self.seen.append((list(messages), list(tools)))
        return self.answers[min(len(self.seen), len(self.answers)) - 1]

    def offered(self, turn: int = 0) -> list[str]:
        return [str(t["function"]["name"]) for t in self.seen[turn][1]]


def asks(name: str, arguments: str) -> Completion:
    return Completion("", "fake", 10, 5, "r", (ToolCall(f"call-{uuid.uuid4()}", name, arguments),))


FINAL = Completion("The server said hi.", "fake", 20, 6, "r2")


def gateway(pool: asyncpg.Pool, s3: S3, model: Script, mcp: McpConfig | None) -> Gateway:
    return Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={("fake", "m"): AllowedModel(frozenset({"tools.test"}), None, unmetered=True)},
        providers={"fake": model},
        retention_days=1,
        mcp=mcp,
    )


@pytest.fixture(autouse=True)
def flag_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset({"mcp-tools"}))


async def in_org(pool: asyncpg.Pool, org_id: str, sql: str, *args: Any) -> list[asyncpg.Record]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch(sql, *args)


async def add_server(
    pool: asyncpg.Pool, org_id: str, url: str = SERVER, tools: Sequence[str] = ("echo", "get-sum")
) -> str:
    row_id = str(uuid.uuid4())
    secret = encrypt_secret("Bearer local-dev-mcp-token", f"{org_id}/{row_id}", KEY_ID, KEY)
    await in_org(
        pool,
        org_id,
        "insert into mcp_servers (id, org_id, name, url, allowed_tools, auth_header, auth_secret)"
        " values ($1, $2, 'everything', $3, $4, 'Authorization', $5)",
        row_id,
        org_id,
        url,
        list(tools),
        secret,
    )
    return row_id


async def run(gw: Gateway, org_id: str, *, mcp_tools: bool = True) -> Any:
    return await gw.call_llm(
        "tools.test",
        [Message("user", "Say hi through the echo tool")],
        model="m",
        provider="fake",
        org_id=org_id,
        actor_id="user-1",
        prompt_template_id="test.tools",
        prompt_template_version="1",
        max_tokens=128,
        mcp_tools=mcp_tools,
    )


async def rows(pool: asyncpg.Pool, org_id: str) -> list[asyncpg.Record]:
    return await in_org(pool, org_id, "select * from ai_calls order by created_at")


async def test_tool_loop_calls_the_server_and_logs_every_step(pool: asyncpg.Pool, s3: S3):
    org_id = await new_org(pool)
    await add_server(pool, org_id)
    model = Script([asks("echo", '{"message": "hi"}'), FINAL])
    result = await run(gateway(pool, s3, model, McpConfig(KEYS, LOOPBACK)), org_id)

    assert result.text == "The server said hi."
    # Only the allowed tools are offered; the server has more (get-env, ...).
    assert sorted(model.offered()) == ["echo", "get-sum"]
    second, _ = model.seen[1]
    assert second[1].role == "assistant" and second[1].tool_calls[0].name == "echo"
    assert second[2].role == "tool" and second[2].content == "Echo: hi"
    assert second[2].tool_call_id == second[1].tool_calls[0].id

    llm1, tool, llm2 = await rows(pool, org_id)
    assert [r["provider"] for r in (llm1, tool, llm2)] == ["fake", "mcp:everything", "fake"]
    assert (tool["request_model"], tool["status"], tool["purpose"]) == ("echo", "ok", "tools.test")
    assert tool["prompt_template_id"] == "mcp.tool" and tool["trace_id"] == llm1["trace_id"]
    assert llm2["id"] == result.call_id
    request = json.loads(await s3.get(tool["request_key"]))
    assert request["arguments"] == '{"message": "hi"}'
    assert request["llm_call_id"] == str(llm1["id"])
    response = json.loads(await s3.get(tool["response_key"]))
    assert response["result"]["content"][0]["text"] == "Echo: hi"
    # The model's request carries the offered tools, its response the tool call.
    assert len(json.loads(await s3.get(llm1["request_key"]))["tools"]) == 2
    assert json.loads(await s3.get(llm1["response_key"]))["tool_calls"][0]["name"] == "echo"


async def test_iteration_cap(pool: asyncpg.Pool, s3: S3):
    org_id = await new_org(pool)
    await add_server(pool, org_id)
    model = Script([asks("get-sum", '{"a": 1, "b": 2}')])  # never stops asking
    with pytest.raises(ToolLoopLimit):
        await run(gateway(pool, s3, model, McpConfig(KEYS, LOOPBACK, max_iterations=2)), org_id)
    assert len(model.seen) == 2
    logged = await rows(pool, org_id)
    assert [r["provider"] for r in logged] == ["fake", "mcp:everything"] * 2
    assert all(r["status"] == "ok" for r in logged)


async def test_tool_not_offered_is_never_called(pool: asyncpg.Pool, s3: S3):
    org_id = await new_org(pool)
    await add_server(pool, org_id)
    model = Script([asks("get-env", "{}"), FINAL])  # the server has it, the org did not allow it
    await run(gateway(pool, s3, model, McpConfig(KEYS, LOOPBACK)), org_id)
    assert model.seen[1][0][-1].content == "tool error: ToolNotOffered"
    _, tool, _ = await rows(pool, org_id)
    assert (tool["provider"], tool["request_model"]) == ("mcp", "unknown")
    assert (tool["status"], tool["error_class"]) == ("error", "ToolNotOffered")


async def test_private_addresses_are_refused(pool: asyncpg.Pool, s3: S3):
    org_id = await new_org(pool)
    await add_server(pool, org_id)  # localhost, not allow-listed here
    await add_server(pool, org_id, "http://10.255.255.1:3001/mcp")
    await add_server(pool, org_id, "http://169.254.169.254/mcp")  # cloud metadata
    model = Script([FINAL])
    result = await run(gateway(pool, s3, model, McpConfig(KEYS, [])), org_id)
    assert result.text == FINAL.text
    assert model.offered() == []
    assert [r["provider"] for r in await rows(pool, org_id)] == ["fake"]


async def test_unreachable_server_is_left_out(pool: asyncpg.Pool, s3: S3):
    org_id = await new_org(pool)
    await add_server(pool, org_id, "http://127.0.0.1:9/mcp")  # allow-listed, nothing listens
    await add_server(pool, org_id)
    model = Script([FINAL])
    await run(gateway(pool, s3, model, McpConfig(KEYS, LOOPBACK, timeout=5)), org_id)
    assert sorted(model.offered()) == ["echo", "get-sum"]


async def test_unreadable_secret_leaves_the_server_out(pool: asyncpg.Pool, s3: S3):
    org_id = await new_org(pool)
    row_id = await add_server(pool, org_id)
    other = parse_keys("local-dev:another-key-that-is-long-enough-0123456789")
    model = Script([FINAL])
    await run(gateway(pool, s3, model, McpConfig(other, LOOPBACK)), org_id)
    assert model.offered() == []
    assert row_id  # the row is still there; the org sees the server in settings


async def test_flag_off_or_not_opted_in_means_no_tools(
    pool: asyncpg.Pool, s3: S3, monkeypatch: pytest.MonkeyPatch
):
    org_id = await new_org(pool)
    await add_server(pool, org_id)
    model = Script([FINAL])
    gw = gateway(pool, s3, model, McpConfig(KEYS, LOOPBACK))
    await run(gw, org_id, mcp_tools=False)
    monkeypatch.setattr(settings, "FLAGS_ON", frozenset[str]())
    await run(gw, org_id)
    await run(gateway(pool, s3, model, None), org_id)  # MCP not configured on this worker
    assert [model.offered(i) for i in range(3)] == [[], [], []]
    logged = await rows(pool, org_id)
    assert [r["provider"] for r in logged] == ["fake"] * 3
    assert all(["tools" not in json.loads(await s3.get(r["request_key"])) for r in logged])


# --- the same loop inside a Temporal activity (unique task queue) ---------------------------

TASK_QUEUE = f"test-mcp-{uuid.uuid4()}"


@dataclass(frozen=True)
class AskInput:
    orgId: str


@workflow.defn(name="TestMcpToolsWorkflow")
class AskWorkflow:
    @workflow.run
    async def run(self, arg: AskInput) -> str:
        return await workflow.execute_activity(
            "test_mcp_ask",
            arg,
            result_type=str,
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


async def test_tool_loop_in_a_temporal_activity(pool: asyncpg.Pool, s3: S3):
    org_id = await new_org(pool)
    await add_server(pool, org_id)
    model = Script([asks("get-sum", '{"a": 2, "b": 3}'), FINAL])
    gw = gateway(pool, s3, model, McpConfig(KEYS, LOOPBACK))

    @activity.defn(name="test_mcp_ask")
    async def ask(arg: AskInput) -> str:
        return (await run(gw, arg.orgId)).text

    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[AskWorkflow],
        activities=[ask],
        workflow_runner=UnsandboxedWorkflowRunner(),
    ):
        text = await client.execute_workflow(
            AskWorkflow.run, AskInput(org_id), id=f"test-mcp-{org_id}", task_queue=TASK_QUEUE
        )
    assert text == FINAL.text
    assert "5" in model.seen[1][0][-1].content  # the server's sum came back to the model
