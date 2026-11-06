"""Drift check: DriftCheckWorkflow on the real Temporal + Postgres + S3, fake LLM providers."""

import json
import uuid
from collections.abc import Sequence
from decimal import Decimal

import asyncpg
import pytest
from temporalio.client import Client
from temporalio.worker import Worker

from tests.conftest import new_org
from worker import settings
from worker.ai import AllowedModel, Completion, Gateway, Message
from worker.judge import DriftCheck, DriftItem, JudgeActivities, JudgeChoice, parse_verdict
from worker.s3 import S3
from worker.workflows import DriftCheckWorkflow

judge_inputs: list[str] = []


async def summarizer(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
    return Completion("Builds a lunar lander for a crewed Moon landing.", model, 50, 12)


async def judge(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
    judge_inputs.append(messages[-1].content)
    return Completion('{"reason": "faithful", "pass": true, "score": 0.75}', model, 300, 20)


@pytest.fixture
def gateway(pool: asyncpg.Pool, s3: S3) -> Gateway:
    return Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={
            ("fake", "summarizer"): AllowedModel(frozenset({"project.summary"}), None),
            ("fake-judge", "judge-model"): AllowedModel(frozenset({"judge"}), None),
        },
        providers={"fake": summarizer, "fake-judge": judge},
        retention_days=30,
    )


async def summary_call(gateway: Gateway, org_id: str) -> uuid.UUID:
    result = await gateway.call_llm(
        "project.summary",
        [Message("system", "Summarize."), Message("user", "Project: Apollo\n\nLand on the Moon.")],
        model="summarizer",
        provider="fake",
        org_id=org_id,
        actor_id="user-1",
        prompt_template_id="project.summary/system",
        prompt_template_version="1",
        max_tokens=64,
    )
    return result.call_id


async def scores(pool: asyncpg.Pool, org_id: str) -> list[asyncpg.Record]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch("select * from ai_scores order by source, name")


async def test_drift_workflow_judges_recent_calls_once(gateway: Gateway, pool: asyncpg.Pool):
    org_id = await new_org(pool)
    call_id = await summary_call(gateway, org_id)
    activities = JudgeActivities(pool, gateway, JudgeChoice("fake-judge", "judge-model"))
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    task_queue = f"test-drift-{uuid.uuid4()}"
    async with Worker(
        client,
        task_queue=task_queue,
        workflows=[DriftCheckWorkflow],
        activities=[activities.sample_for_drift, activities.judge_call],
    ):
        run = lambda: client.execute_workflow(  # noqa: E731
            DriftCheckWorkflow.run,
            DriftCheck(perPurpose=5, lookbackHours=1),
            id=f"drift-{uuid.uuid4()}",
            task_queue=task_queue,
        )
        assert await run() >= 1  # other orgs' leftover calls may be judged too
        [judge_score, rule_score] = await scores(pool, org_id)
        assert await run() >= 0
    assert len(await scores(pool, org_id)) == 2  # second run: nothing re-judged for this org

    assert (judge_score["call_id"], judge_score["source"], judge_score["name"]) == (
        call_id,
        "judge",
        "quality",
    )
    assert judge_score["value"] == Decimal("0.75")
    assert (rule_score["source"], rule_score["name"], rule_score["value"]) == (
        "rule",
        "max_30_words",
        Decimal("1"),
    )
    # The judge saw the original input and output, via the versioned judge prompt.
    assert any("Land on the Moon." in t and "lunar lander" in t for t in judge_inputs)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        judge_call = await conn.fetchrow(
            "select * from ai_calls where id = $1", judge_score["judge_call_id"]
        )
    assert judge_call is not None
    assert (judge_call["purpose"], judge_call["request_model"]) == ("judge", "judge-model")
    assert (judge_call["prompt_template_id"], judge_call["prompt_template_version"]) == (
        "judge/project.summary",
        "1",
    )


async def test_judge_is_retry_safe_and_off_without_model(gateway: Gateway, pool: asyncpg.Pool):
    org_id = await new_org(pool)
    item = DriftItem(org_id, str(await summary_call(gateway, org_id)))
    assert await JudgeActivities(pool, gateway, None).judge_call(item) is None
    activities = JudgeActivities(pool, gateway, JudgeChoice("fake-judge", "judge-model"))
    assert await activities.judge_call(item) == 0.75
    assert await activities.judge_call(item) is None  # retry: already scored, no 2nd call
    assert len(await scores(pool, org_id)) == 2


def test_parse_verdict():
    assert parse_verdict('{"pass": true, "score": 1}') == 1.0
    assert parse_verdict('Sure! {"reason": "x", "score": 0.4}') == 0.4
    for bad in ["no json", '{"score": 2}', '{"score": "0.5"}', '{"score": true}', "{bad"]:
        assert parse_verdict(bad) is None, bad
    assert json.loads('{"score": 0}')["score"] == 0 and parse_verdict('{"score": 0}') == 0.0
