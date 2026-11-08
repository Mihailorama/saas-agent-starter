"""`python -m worker.selfcheck` (pnpm run infra -- verify) against the compose S3, Mailpit and a
fake LLM provider through the real Gateway."""

import uuid
from collections.abc import Sequence
from decimal import Decimal

import asyncpg
import httpx2
import pytest

from tests.conftest import new_org
from tests.test_mail import MAILPIT_URL
from worker import selfcheck, settings
from worker.ai import AllowedModel, Completion, Gateway, Message, Price
from worker.s3 import S3


async def test_s3_roundtrip(s3: S3) -> None:
    assert "put, get and delete" in await selfcheck.check_s3(s3)


async def test_smtp_sends_one_mail() -> None:
    to = f"{uuid.uuid4()}@example.com"
    await selfcheck.check_smtp(to)
    async with httpx2.AsyncClient(base_url=MAILPIT_URL) as http:
        found = (await http.get("/api/v1/search", params={"query": f"to:{to}"})).json()
    assert found["messages"][0]["Subject"] == "Self-check: mail delivery works"


async def test_llm_one_token_call_is_logged(pool: asyncpg.Pool, s3: S3) -> None:
    seen: list[int] = []

    async def fake(
        model: str, messages: Sequence[Message], max_tokens: int, _tools: object = ()
    ) -> Completion:
        seen.append(max_tokens)
        return Completion("ok", model, 20, 1, "fake-1")

    gateway = Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={
            ("fake", "fake-model"): AllowedModel(
                frozenset({"project.summary"}), Price(Decimal("0.001"), Decimal("0.002"), "USD")
            )
        },
        providers={"fake": fake},
        retention_days=30,
    )
    org_id = await new_org(pool)
    assert "fake/fake-model answered" in await selfcheck.check_llm(
        gateway, org_id, "fake", "fake-model"
    )
    assert seen == [1]
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        assert await conn.fetchval("select count(*) from ai_calls where status = 'ok'") == 1


def test_unconfigured_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "AI_CONTOUR", "")
    assert selfcheck.main(["llm"]) == selfcheck.SKIP
    monkeypatch.setattr(settings, "SMTP_URL", "")
    assert selfcheck.main(["smtp"]) == selfcheck.SKIP
