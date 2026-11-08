"""PostHog $ai_generation per LLM call, against a mocked capture endpoint (no network)."""

import json
from collections.abc import Sequence
from decimal import Decimal
from typing import Any

import asyncpg
import httpx2
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from tests.conftest import new_org
from worker.ai import AllowedModel, Completion, Gateway, Message, Price
from worker.posthog import PostHogAi
from worker.s3 import S3

PROMPT = "the confidential launch plan"


async def fake(
    model: str, messages: Sequence[Message], max_tokens: int, _tools: object = ()
) -> Completion:
    return Completion("A summary.", f"{model}-20261101", 100, 10, "r1")


async def broken(
    model: str, messages: Sequence[Message], max_tokens: int, _tools: object = ()
) -> Completion:
    raise TimeoutError


def capturing(privacy_mode: bool, status: int = 200) -> tuple[PostHogAi, list[dict[str, Any]]]:
    sent: list[dict[str, Any]] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        assert str(request.url) == "https://eu.i.posthog.com/i/v0/e/"
        sent.append(json.loads(request.content))
        return httpx2.Response(status)

    http = httpx2.AsyncClient(transport=httpx2.MockTransport(handle))
    ph = PostHogAi(
        host="https://eu.i.posthog.com", api_key="phc_test", privacy_mode=privacy_mode, http=http
    )
    return ph, sent


def gateway(pool: asyncpg.Pool, s3: S3, posthog: PostHogAi) -> Gateway:
    trace.set_tracer_provider(TracerProvider())  # what worker/__main__.py always installs
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
        retention_days=1,
        posthog=posthog,
    )


async def call(g: Gateway, org_id: str, provider: str, model: str) -> Any:
    return await g.call_llm(
        "project.summary",
        [Message("user", PROMPT)],
        model=model,
        provider=provider,
        org_id=org_id,
        actor_id="user-1",
        prompt_template_id="project.summary/system",
        prompt_template_version="1",
        max_tokens=64,
    )


async def trace_ids(pool: asyncpg.Pool, org_id: str) -> asyncpg.Record:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        row = await conn.fetchrow("select id, trace_id, span_id from ai_calls")
    assert row is not None
    return row


async def test_generation_event_in_privacy_mode(pool: asyncpg.Pool, s3: S3):
    ph, sent = capturing(privacy_mode=True)
    org_id = await new_org(pool)
    await call(gateway(pool, s3, ph), org_id, "fake", "fake-model")
    row = await trace_ids(pool, org_id)
    [event] = sent
    assert (event["event"], event["api_key"], event["distinct_id"]) == (
        "$ai_generation",
        "phc_test",
        "user-1",
    )
    p = event["properties"]
    # Same trace as our span and ai_calls row: browser feedback joins on it.
    assert (p["$ai_trace_id"], p["$ai_span_id"]) == (row["trace_id"], row["span_id"])
    assert len(p["$ai_trace_id"]) == 32
    assert p["$ai_model"] == "fake-model-20261101" and p["$ai_provider"] == "fake"
    assert (p["$ai_input_tokens"], p["$ai_output_tokens"]) == (100, 10)
    assert p["$ai_total_cost_usd"] == pytest.approx(0.00012)  # (100 * 0.001 + 10 * 0.002) / 1000
    assert p["$ai_is_error"] is False and p["ai_call_id"] == str(row["id"])
    assert p["ai_prompt_template"] == "project.summary/system" and p["ai_prompt_version"] == "1"
    assert "$ai_input" not in p and "$ai_output_choices" not in p
    assert PROMPT not in json.dumps(event) and "A summary." not in json.dumps(event)


async def test_content_only_without_privacy_mode_and_errors_are_reported(
    pool: asyncpg.Pool, s3: S3
):
    ph, sent = capturing(privacy_mode=False)
    g = gateway(pool, s3, ph)
    await call(g, await new_org(pool), "fake", "fake-model")
    assert sent[0]["properties"]["$ai_input"] == [{"role": "user", "content": PROMPT}]
    assert sent[0]["properties"]["$ai_output_choices"] == [
        {"role": "assistant", "content": "A summary."}
    ]
    with pytest.raises(TimeoutError):
        await call(g, await new_org(pool), "broken", "broken-model")
    p = sent[1]["properties"]
    assert (p["$ai_is_error"], p["$ai_error"]) == (True, "TimeoutError")
    assert "$ai_output_choices" not in p


async def test_posthog_outage_never_fails_the_call(pool: asyncpg.Pool, s3: S3):
    ph, sent = capturing(privacy_mode=True, status=503)
    result = await call(gateway(pool, s3, ph), await new_org(pool), "fake", "fake-model")
    assert result.text == "A summary." and len(sent) == 1
