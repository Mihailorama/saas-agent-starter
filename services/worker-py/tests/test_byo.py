"""Organization-owned providers (BYO) through the gateway, against Postgres + S3 and an HTTP mock.

The org's key is encrypted like a webhook secret and bound to org and row id; it is used only
for that org's calls, only while its plan includes BYO, and the base URL passes the SSRF guard.
"""

import json
import uuid
from collections.abc import Iterator, Sequence
from datetime import UTC, datetime, timedelta
from ipaddress import ip_network
from typing import Any

import asyncpg
import pytest

from tests.conftest import new_org
from tests.test_providers import Mock
from worker import settings
from worker.ai import AllowedModel, Byo, Completion, Gateway, Message, ProviderBlocked
from worker.billing import load_plans
from worker.providers import load_providers
from worker.s3 import S3
from worker.webhooks import encrypt_secret, parse_keys

KEYS = parse_keys("local-dev:local-dev-byo-test-encryption-key-0123456789")
KEY_ID, KEY = next(iter(KEYS.items()))
operator_calls: list[str] = []


async def operator(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
    operator_calls.append(model)
    return Completion("operator answer", model, 10, 2, "op-1")


@pytest.fixture(scope="module")
def mock() -> Iterator[Mock]:
    m = Mock()
    yield m
    m.server.shutdown()


@pytest.fixture
def gateway(pool: asyncpg.Pool, s3: S3) -> Gateway:
    configs = load_providers(
        settings.AI_MODELS_FILE, {}, cli_url="", cli_token="", timeout=10, cli_timeout=10
    )
    return Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={("fake", "op-model"): AllowedModel(frozenset({"project.summary"}), None, True)},
        providers={"fake": operator},
        provider_configs=configs,
        retention_days=1,
        plans=load_plans(settings.PLANS_FILE),
        byo=Byo(KEYS, [ip_network("127.0.0.0/8")]),
    )


async def in_org(pool: asyncpg.Pool, org_id: str, sql: str, *args: Any) -> list[asyncpg.Record]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch(sql, *args)


async def pro(pool: asyncpg.Pool, org_id: str) -> None:
    now = datetime.now(UTC)
    await in_org(
        pool,
        org_id,
        "insert into subscriptions (org_id, plan_id, status, contour, provider, currency,"
        " current_period_start, current_period_end) values ($1, 'pro', 'active', 'en', 'stripe',"
        " 'USD', $2, $3)",
        org_id,
        now - timedelta(days=1),
        now + timedelta(days=29),
    )


async def own_provider(
    pool: asyncpg.Pool, org_id: str, base_url: str, key: str, *, stored: str | None = None
) -> str:
    row_id = str(uuid.uuid4())
    await in_org(
        pool,
        org_id,
        "insert into ai_providers (id, org_id, name, provider, base_url, api_key, models)"
        " values ($1, $2, 'mine', 'openai_compatible', $3, $4, $5)",
        row_id,
        org_id,
        base_url,
        stored or encrypt_secret(key, f"{org_id}/{row_id}", KEY_ID, KEY),
        json.dumps({"project.summary": "org-model"}),
    )
    return row_id


async def summarize(gateway: Gateway, org_id: str) -> Any:
    return await gateway.call_llm(
        "project.summary",
        [Message("user", "Summarize Apollo")],
        model="op-model",
        provider="fake",
        org_id=org_id,
        actor_id=None,
        prompt_template_id="t",
        prompt_template_version="1",
        max_tokens=16,
    )


async def test_org_provider_serves_only_its_org(
    gateway: Gateway, pool: asyncpg.Pool, mock: Mock
) -> None:
    a, b = await new_org(pool), await new_org(pool)
    await pro(pool, a)
    await pro(pool, b)
    await own_provider(pool, a, f"{mock.url}/v1", "local-dev-key-of-org-a")
    mock.seen.clear()
    before = len(operator_calls)

    result = await summarize(gateway, a)
    assert result.text == "Hello."
    [sent] = mock.posts()
    assert sent["headers"]["authorization"] == "Bearer local-dev-key-of-org-a"
    assert sent["body"]["model"] == "org-model"
    [row] = await in_org(pool, a, "select provider, request_model, cost from ai_calls")
    assert (row["provider"], row["request_model"], row["cost"]) == (
        "byo:openai_compatible",
        "org-model",
        None,  # the org pays its own provider: no cost, no plan limit
    )

    # Org B has no provider of its own: the operator's model, and A's key is never used.
    assert (await summarize(gateway, b)).text == "operator answer"
    assert len(operator_calls) == before + 1
    assert len(mock.posts()) == 1


async def test_key_bound_to_org_and_row(gateway: Gateway, pool: asyncpg.Pool, mock: Mock) -> None:
    a, b = await new_org(pool), await new_org(pool)
    await pro(pool, a)
    await pro(pool, b)
    await own_provider(pool, a, f"{mock.url}/v1", "local-dev-key-of-org-a")
    [stolen] = await in_org(pool, a, "select api_key from ai_providers")
    # A ciphertext copied into another org's row does not decrypt there: refused, not rerouted.
    await own_provider(pool, b, f"{mock.url}/v1", "", stored=stolen["api_key"])
    mock.seen.clear()
    with pytest.raises(ProviderBlocked):
        await summarize(gateway, b)
    assert mock.posts() == []
    assert await in_org(pool, b, "select id from ai_calls") == []


async def test_plan_and_ssrf_rules(gateway: Gateway, pool: asyncpg.Pool, mock: Mock) -> None:
    free, private = await new_org(pool), await new_org(pool)
    await own_provider(pool, free, f"{mock.url}/v1", "local-dev-key")
    # Free plan has no byoLlm: the operator's models serve it.
    assert (await summarize(gateway, free)).text == "operator answer"

    await pro(pool, private)
    await own_provider(pool, private, "http://10.1.2.3/v1", "local-dev-key")  # not allow-listed
    with pytest.raises(ProviderBlocked):
        await summarize(gateway, private)
