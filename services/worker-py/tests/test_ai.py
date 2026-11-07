"""AI gateway against the compose stack (Postgres + S3) with fake providers: no network."""

import json
import uuid
from collections.abc import Sequence
from decimal import Decimal
from typing import Any

import asyncpg
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from tests.conftest import new_org
from worker import settings
from worker.activities import Activities, ModelChoice, ProjectCreated
from worker.ai import (
    AllowedModel,
    Completion,
    Gateway,
    Message,
    ModelNotAllowed,
    Price,
    load_registry,
)
from worker.s3 import S3

PROMPT = "Summarize: the secret launch plan for Apollo"
spans = InMemorySpanExporter()


async def fake(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
    return Completion("A short summary.", f"{model}-20261101", 1200, 80, "fake-response-1")


async def broken(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
    raise TimeoutError


@pytest.fixture(scope="module", autouse=True)
def tracing() -> None:
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(spans))
    trace.set_tracer_provider(provider)


@pytest.fixture
def gateway(pool: asyncpg.Pool, s3: S3) -> Gateway:
    return Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={
            ("fake", "fake-model"): AllowedModel(
                frozenset({"project.summary"}), Price(Decimal("0.001"), Decimal("0.002"), "USD")
            ),
            ("broken", "broken-model"): AllowedModel(
                frozenset({"project.summary"}), None, unmetered=True
            ),
        },
        providers={"fake": fake, "broken": broken},
        retention_days=30,
    )


async def call(gateway: Gateway, org_id: str, provider: str, model: str, purpose: str) -> Any:
    return await gateway.call_llm(
        purpose,
        [Message("user", PROMPT)],
        model=model,
        provider=provider,
        org_id=org_id,
        actor_id="user-1",
        prompt_template_id="test.summary",
        prompt_template_version="7",
        max_tokens=256,
    )


async def ai_calls(pool: asyncpg.Pool, org_id: str) -> list[asyncpg.Record]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch("select * from ai_calls order by created_at")


def span_for(call_id: uuid.UUID) -> ReadableSpan:
    [span] = [
        s
        for s in spans.get_finished_spans()
        if (s.attributes or {}).get("app.ai.call_id") == str(call_id)
    ]
    return span


async def test_call_writes_row_content_and_span(gateway: Gateway, pool: asyncpg.Pool, s3: S3):
    org_id = await new_org(pool)
    result = await call(gateway, org_id, "fake", "fake-model", "project.summary")
    assert result.text == "A short summary."

    [row] = await ai_calls(pool, org_id)
    assert row["id"] == result.call_id
    assert (row["purpose"], row["provider"], row["actor_id"]) == (
        "project.summary",
        "fake",
        "user-1",
    )
    assert (row["request_model"], row["response_model"]) == ("fake-model", "fake-model-20261101")
    assert (row["prompt_template_id"], row["prompt_template_version"]) == ("test.summary", "7")
    assert (row["input_tokens"], row["output_tokens"], row["total_tokens"]) == (1200, 80, 1280)
    assert row["cost"] == Decimal("0.001360") and row["cost_currency"] == "USD"
    assert (row["status"], row["error_class"], row["contour"]) == ("ok", None, "eu")
    assert row["latency_ms"] >= 0
    assert (row["content_expires_at"] - row["created_at"]).days in (29, 30)

    request = json.loads(await s3.get(row["request_key"]))
    assert request["messages"] == [{"role": "user", "content": PROMPT}]
    assert json.loads(await s3.get(row["response_key"]))["text"] == "A short summary."

    span = span_for(result.call_id)
    attrs = dict(span.attributes or {})
    assert span.name == "chat fake-model"
    assert attrs["gen_ai.system"] == attrs["gen_ai.provider.name"] == "fake"
    assert attrs["gen_ai.request.model"] == "fake-model"
    assert attrs["gen_ai.response.model"] == "fake-model-20261101"
    assert (attrs["gen_ai.usage.input_tokens"], attrs["gen_ai.usage.output_tokens"]) == (1200, 80)
    ctx = span.get_span_context()
    assert ctx is not None
    assert (row["trace_id"], row["span_id"]) == (f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}")
    assert attrs["gen_ai.input.messages_ref"] == f"s3://{s3.bucket}/{row['request_key']}"
    assert attrs["gen_ai.output.messages_ref"] == f"s3://{s3.bucket}/{row['response_key']}"
    # Prompt and completion content never go into span attributes.
    assert not any(PROMPT in str(v) or "short summary" in str(v) for v in attrs.values())


async def test_provider_error_is_logged_and_raised(gateway: Gateway, pool: asyncpg.Pool):
    org_id = await new_org(pool)
    with pytest.raises(TimeoutError):
        await call(gateway, org_id, "broken", "broken-model", "project.summary")
    [row] = await ai_calls(pool, org_id)
    assert (row["status"], row["error_class"], row["response_key"]) == (
        "error",
        "TimeoutError",
        None,
    )
    assert row["cost"] is None and row["input_tokens"] is None


async def test_refuses_models_outside_the_registry(gateway: Gateway, pool: asyncpg.Pool):
    org_id = await new_org(pool)
    with pytest.raises(ModelNotAllowed):
        await call(gateway, org_id, "fake", "some-other-model", "project.summary")
    with pytest.raises(ModelNotAllowed):  # registered model, but not for this purpose
        await call(gateway, org_id, "fake", "fake-model", "contract.review")
    assert await ai_calls(pool, org_id) == []


def test_registry_is_per_contour():
    eu = load_registry(settings.AI_MODELS_FILE, "eu")
    ru = load_registry(settings.AI_MODELS_FILE, "ru")
    assert ("anthropic", "claude-haiku-5-5") in eu
    assert ("anthropic", "claude-haiku-5-5") not in ru
    with pytest.raises(ValueError, match="contour"):
        load_registry(settings.AI_MODELS_FILE, "mars")


async def test_summarize_project_stores_generated_summary_once(
    gateway: Gateway, pool: asyncpg.Pool
):
    org_id, project_id = await new_org(pool), str(uuid.uuid4())
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        await conn.execute(
            "insert into projects (id, org_id, name, description) values ($1, $2, 'Apollo', $3)",
            project_id,
            org_id,
            "Land on the Moon and return safely.",
        )
    event = ProjectCreated(orgId=org_id, projectId=project_id, name="Apollo", actorId="user-1")
    activities = Activities(pool, gateway, ModelChoice("fake", "fake-model"))

    assert await activities.summarize_project(event) == "A short summary."
    assert await activities.summarize_project(event) == "A short summary."  # retry: no 2nd call

    [row] = await ai_calls(pool, org_id)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        project = await conn.fetchrow("select * from projects where id = $1", project_id)
    assert project is not None
    assert (project["ai_summary"], project["ai_status"]) == ("A short summary.", "generated")
    assert project["ai_call_id"] == row["id"]
    assert row["actor_id"] == "user-1"


async def test_summarize_is_off_without_a_model(pool: asyncpg.Pool, gateway: Gateway):
    event = ProjectCreated(orgId="x", projectId=str(uuid.uuid4()), name="x")
    assert await Activities(pool, gateway, None).summarize_project(event) is None
