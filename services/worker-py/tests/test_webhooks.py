"""Webhook delivery against the compose stack (Temporal + Postgres) and a local HTTP receiver."""

import base64
import json
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address, ip_network

import asyncpg
import pytest
from cryptography.exceptions import InvalidTag
from standardwebhooks import Webhook
from temporalio.client import Client
from temporalio.worker import Worker

from tests.conftest import new_org
from worker import settings
from worker.webhooks import (
    BlockedAddress,
    WebhookActivities,
    WebhookEvent,
    decrypt_secret,
    encrypt_secret,
    is_blocked,
    parse_keys,
    resolve_public,
    sign,
)
from worker.workflows import WebhookEventWorkflow, ensure_maintenance_schedule

SECRET = "whsec_" + base64.b64encode(b"local-dev-webhook-secret").decode()
OLD_SECRET = "whsec_" + base64.b64encode(b"local-dev-rotated-secret").decode()
LOOPBACK = [ip_network("127.0.0.0/8"), ip_network("::1/128")]
# The local-dev key from .env.example; the API encrypts with it, only the worker decrypts.
KEYS = parse_keys("local-dev:change-me-local-dev-webhook-encryption-key")


def sealed(secret: str, endpoint_id: str) -> str:
    return encrypt_secret(secret, endpoint_id, "local-dev", KEYS["local-dev"])


class Receiver:
    """Answers with the scripted statuses (then 200) and keeps what it received."""

    def __init__(self) -> None:
        self.script: list[int] = []
        self.received: list[tuple[dict[str, str], str]] = []
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers["content-length"])).decode()
                headers = {k.lower(): v for k, v in self.headers.items()}
                receiver.received.append((headers, body))
                self.send_response(receiver.script.pop(0) if receiver.script else 200)
                self.send_header("content-length", "0")
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/hooks?src=test"


@pytest.fixture
def receiver() -> Iterator[Receiver]:
    r = Receiver()
    thread = threading.Thread(target=r.server.serve_forever, daemon=True)
    thread.start()
    yield r
    r.server.shutdown()


TASK_QUEUE = f"test-webhooks-{uuid.uuid4()}"
STRICT_QUEUE = f"test-webhooks-strict-{uuid.uuid4()}"


@pytest.fixture(scope="session")
async def client(pool: asyncpg.Pool) -> AsyncIterator[Client]:
    """Two workers: one allows loopback (the local receiver), one has the default SSRF policy."""
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    lenient = WebhookActivities(
        pool,
        allowed_networks=LOOPBACK,
        encryption_keys=KEYS,
        max_payload_bytes=2048,
        disable_after_failures=2,
    )
    strict = WebhookActivities(pool, encryption_keys=KEYS)
    async with (
        Worker(
            client,
            task_queue=TASK_QUEUE,
            workflows=[WebhookEventWorkflow],
            activities=[lenient.deliver_webhook],
        ),
        Worker(
            client,
            task_queue=STRICT_QUEUE,
            workflows=[WebhookEventWorkflow],
            activities=[strict.deliver_webhook],
        ),
    ):
        yield client
    await lenient.close()
    await strict.close()


BODY = json.dumps(
    {"type": "project.created", "timestamp": "2026-11-07T00:00:00Z", "data": {"id": "p1"}}
)


async def new_endpoint(
    pool: asyncpg.Pool,
    org_id: str,
    url: str,
    *,
    secret: str | None = None,
    previous_secret: str | None = None,
) -> str:
    """An endpoint as the API stores it: secrets encrypted and bound to the endpoint id."""
    endpoint_id = str(uuid.uuid4())
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        await conn.execute(
            "insert into webhook_endpoints (id, org_id, url, event_types, secret,"
            " previous_secret, previous_secret_expires_at) values ($1, $2, $3, $4, $5, $6, $7)",
            endpoint_id,
            org_id,
            url,
            ["project.created"],
            secret or sealed(SECRET, endpoint_id),
            previous_secret and sealed(previous_secret, endpoint_id),
            datetime.now(UTC) + timedelta(hours=1) if previous_secret else None,
        )
    return endpoint_id


async def add_event(
    pool: asyncpg.Pool, org_id: str, endpoint_id: str, payload: str = BODY
) -> tuple[str, str]:
    """An event and its pending delivery, as publishEvent() writes them."""
    event_id = str(uuid.uuid4())
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        await conn.execute(
            "insert into webhook_events (id, org_id, type, payload) values ($1, $2, $3, $4)",
            event_id,
            org_id,
            "project.created",
            payload,
        )
        delivery_id: str = await conn.fetchval(
            "insert into webhook_deliveries (org_id, event_id, endpoint_id)"
            " values ($1, $2, $3) returning id::text",
            org_id,
            event_id,
            endpoint_id,
        )
    return event_id, delivery_id


async def setup_delivery(
    pool: asyncpg.Pool,
    url: str,
    *,
    payload: str = BODY,
    previous_secret: str | None = None,
) -> tuple[str, str, str]:
    org_id = await new_org(pool)
    endpoint_id = await new_endpoint(pool, org_id, url, previous_secret=previous_secret)
    event_id, delivery_id = await add_event(pool, org_id, endpoint_id, payload)
    return org_id, event_id, delivery_id


async def run(
    client: Client,
    org_id: str,
    event_id: str,
    delivery_id: str,
    *,
    queue: str = TASK_QUEUE,
    replay: bool = False,
    max_attempts: int = 3,
) -> list[str]:
    return await client.execute_workflow(
        WebhookEventWorkflow.run,
        WebhookEvent(
            orgId=org_id,
            eventId=event_id,
            deliveryIds=[delivery_id],
            replay=replay,
            retryInitialSeconds=0.2,
            maxAttempts=max_attempts,
        ),
        id=f"test-webhook-{uuid.uuid4()}",
        task_queue=queue,
    )


async def attempts(pool: asyncpg.Pool, org_id: str, delivery_id: str) -> list[asyncpg.Record]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch(
            "select a.attempt, a.status_code, a.error, d.status from webhook_attempts a"
            " join webhook_deliveries d on d.id = a.delivery_id"
            " where a.delivery_id = $1 order by a.attempt",
            delivery_id,
        )


def test_signature_matches_the_reference_library() -> None:
    body = '{"type":"project.created"}'
    now = int(datetime.now(UTC).timestamp())
    headers = {
        "webhook-id": "msg_1",
        "webhook-timestamp": str(now),
        "webhook-signature": sign(SECRET, "msg_1", now, body),
    }
    assert Webhook(SECRET).verify(body, headers) == {"type": "project.created"}
    with pytest.raises(Exception, match="No matching signature"):
        Webhook(OLD_SECRET).verify(body, headers)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",  # cloud metadata
        "100.64.0.1",  # carrier-grade NAT
        "0.0.0.0",  # noqa: S104 - an address under test, not a bind
        "224.0.0.1",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",  # IPv4-mapped loopback
    ],
)
def test_non_public_addresses_are_blocked(ip: str) -> None:
    assert is_blocked(ip_address(ip))


def test_public_and_allowlisted_addresses_pass() -> None:
    assert not is_blocked(ip_address("93.184.215.14"))
    assert not is_blocked(ip_address("2606:4700::1111"))
    assert not is_blocked(ip_address("127.0.0.1"), LOOPBACK)


async def test_hostnames_are_resolved_before_the_check() -> None:
    with pytest.raises(BlockedAddress):
        await resolve_public("localhost", 80)
    assert await resolve_public("localhost", 80, LOOPBACK) in ("127.0.0.1", "::1")


async def test_signed_delivery_is_retried_after_a_500(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    receiver.script = [500]
    org_id, event_id, delivery_id = await setup_delivery(pool, receiver.url)

    assert await run(client, org_id, event_id, delivery_id) == ["succeeded"]

    assert len(receiver.received) == 2
    for headers, body in receiver.received:
        # Verified with the Standard Webhooks reference library, as a customer would.
        assert Webhook(SECRET).verify(body, headers)["data"] == {"id": "p1"}
        assert headers["webhook-id"] == event_id  # same id on every attempt: dedupe key
        assert headers["host"].startswith("127.0.0.1:")
    rows = await attempts(pool, org_id, delivery_id)
    assert [(r["attempt"], r["status_code"], r["error"]) for r in rows] == [
        (1, 500, None),
        (2, 200, None),
    ]
    assert rows[-1]["status"] == "succeeded"

    # A re-run (e.g. activity retried after the write) does not send again; a replay does.
    assert await run(client, org_id, event_id, delivery_id) == ["succeeded"]
    assert len(receiver.received) == 2
    assert await run(client, org_id, event_id, delivery_id, replay=True) == ["succeeded"]
    assert len(receiver.received) == 3
    assert receiver.received[2][1] == receiver.received[0][1]  # same bytes


async def test_gives_up_after_max_attempts(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    receiver.script = [503, 503, 503]
    org_id, event_id, delivery_id = await setup_delivery(pool, receiver.url)
    assert await run(client, org_id, event_id, delivery_id) == ["failed"]
    rows = await attempts(pool, org_id, delivery_id)
    assert [r["status_code"] for r in rows] == [503, 503, 503]
    assert rows[-1]["status"] == "failed"


async def test_rotated_secret_signs_with_both(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    org_id, event_id, delivery_id = await setup_delivery(
        pool, receiver.url, previous_secret=OLD_SECRET
    )
    assert await run(client, org_id, event_id, delivery_id) == ["succeeded"]
    headers, body = receiver.received[0]
    assert len(headers["webhook-signature"].split(" ")) == 2
    assert Webhook(SECRET).verify(body, headers)
    assert Webhook(OLD_SECRET).verify(body, headers)  # receivers not yet switched keep working


async def test_private_targets_are_refused_without_a_request(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    for url in (receiver.url, receiver.url.replace("127.0.0.1", "localhost")):
        org_id, event_id, delivery_id = await setup_delivery(pool, url)
        assert await run(client, org_id, event_id, delivery_id, queue=STRICT_QUEUE) == ["failed"]
        rows = await attempts(pool, org_id, delivery_id)
        assert [(r["status_code"], r["error"]) for r in rows] == [(None, "blocked_address")]
    assert receiver.received == []


async def test_oversized_payload_is_not_sent(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    big = json.dumps({"type": "project.created", "data": {"x": "a" * 4096}})
    org_id, event_id, delivery_id = await setup_delivery(pool, receiver.url, payload=big)
    assert await run(client, org_id, event_id, delivery_id) == ["failed"]
    rows = await attempts(pool, org_id, delivery_id)
    assert [r["error"] for r in rows] == ["payload_too_large"]
    assert receiver.received == []


# Produced by apps/api/src/webhook-secret.ts (encryptSecret) with the local-dev key: the API and
# the worker agree on the format.
FROM_NODE = (
    "v1:local-dev:3QU11prwNOQywgET:w1BK9qCZDji4hNdrNDQetBi0CdAFwe7kSfplIx6y298LkU0did8YaVphod4tRg=="
)
NODE_ENDPOINT = "11111111-2222-4333-8444-555555555555"


def test_decrypts_what_the_api_encrypts() -> None:
    assert decrypt_secret(FROM_NODE, NODE_ENDPOINT, KEYS) == "whsec_bG9jYWwtZGV2LXZlY3Rvcg=="
    with pytest.raises(InvalidTag):  # bound to its endpoint: a copied row does not decrypt
        decrypt_secret(FROM_NODE, str(uuid.uuid4()), KEYS)


async def endpoint_state(pool: asyncpg.Pool, org_id: str, endpoint_id: str) -> asyncpg.Record:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        row = await conn.fetchrow(
            "select e.enabled, e.disabled_reason, e.consecutive_failures,"
            " (select count(*) from audit_log a where a.target = e.id::text"
            "  and a.action = 'webhook_endpoint.disabled') as disabled_audits"
            " from webhook_endpoints e where e.id = $1",
            endpoint_id,
        )
        assert row is not None
        return row


async def test_unreadable_secret_is_not_sent(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    org_id = await new_org(pool)
    copied = sealed(SECRET, str(uuid.uuid4()))  # ciphertext of another endpoint
    endpoint_id = await new_endpoint(pool, org_id, receiver.url, secret=copied)
    event_id, delivery_id = await add_event(pool, org_id, endpoint_id)
    assert await run(client, org_id, event_id, delivery_id) == ["failed"]
    assert [r["error"] for r in await attempts(pool, org_id, delivery_id)] == ["secret_unreadable"]
    assert receiver.received == []


async def test_410_disables_the_endpoint_at_once(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    receiver.script = [410]
    org_id = await new_org(pool)
    endpoint_id = await new_endpoint(pool, org_id, receiver.url)
    event_id, delivery_id = await add_event(pool, org_id, endpoint_id)
    assert await run(client, org_id, event_id, delivery_id) == ["failed"]
    assert len(receiver.received) == 1  # no retries after 410
    state = await endpoint_state(pool, org_id, endpoint_id)
    assert (state["enabled"], state["disabled_reason"], state["disabled_audits"]) == (
        False,
        "gone",
        1,
    )
    # Pending work for a disabled endpoint is not sent either.
    event_id, delivery_id = await add_event(pool, org_id, endpoint_id)
    assert await run(client, org_id, event_id, delivery_id) == ["failed"]
    assert len(receiver.received) == 1


async def test_consecutive_failures_disable_the_endpoint(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    org_id = await new_org(pool)
    endpoint_id = await new_endpoint(pool, org_id, receiver.url)

    async def deliver(status: int) -> str:
        receiver.script = [status]
        event_id, delivery_id = await add_event(pool, org_id, endpoint_id)
        [result] = await run(client, org_id, event_id, delivery_id, max_attempts=1)
        return result

    # The worker under test disables after 2 failed deliveries in a row; a success resets.
    assert await deliver(500) == "failed"
    assert await deliver(200) == "succeeded"
    assert (await endpoint_state(pool, org_id, endpoint_id))["consecutive_failures"] == 0
    assert await deliver(500) == "failed"
    assert (await endpoint_state(pool, org_id, endpoint_id))["enabled"]
    assert await deliver(503) == "failed"
    state = await endpoint_state(pool, org_id, endpoint_id)
    assert (state["enabled"], state["disabled_reason"], state["consecutive_failures"]) == (
        False,
        "failures",
        2,
    )
    assert state["disabled_audits"] == 1


async def test_suspended_org_gets_no_deliveries(
    client: Client, pool: asyncpg.Pool, receiver: Receiver
) -> None:
    """Queued before the suspension, checked at delivery: nothing is sent, the endpoint keeps
    its failure count (the receiver did nothing wrong)."""
    org_id, event_id, delivery_id = await setup_delivery(pool, receiver.url)
    await pool.execute("update organization set suspended_at = now() where id = $1", org_id)
    assert await run(client, org_id, event_id, delivery_id) == ["failed"]
    rows = await attempts(pool, org_id, delivery_id)
    assert [(r["status_code"], r["error"]) for r in rows] == [(None, "org_suspended")]
    assert receiver.received == []
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        failures = await conn.fetchval("select max(consecutive_failures) from webhook_endpoints")
    assert failures == 0


async def test_retention_deletes_old_events_and_attempts(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    endpoint_id = await new_endpoint(pool, org_id, "https://hooks.example.com/in")
    old_event, old_delivery = await add_event(pool, org_id, endpoint_id)
    new_event, new_delivery = await add_event(pool, org_id, endpoint_id)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        for delivery in (old_delivery, new_delivery):
            await conn.execute(
                "insert into webhook_attempts (org_id, delivery_id, attempt, status_code,"
                " duration_ms) values ($1, $2, 1, 200, 5)",
                org_id,
                delivery,
            )
        old = datetime.now(UTC) - timedelta(days=31)
        await conn.execute(
            "update webhook_events set created_at = $1 where id = $2", old, old_event
        )
        await conn.execute(
            "update webhook_attempts set created_at = $1 where delivery_id = $2", old, old_delivery
        )

    pruned = await WebhookActivities(pool, encryption_keys=KEYS, retention_days=30).prune_webhooks()
    assert pruned >= 2  # the old attempt and the old event (its delivery cascades)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        left = await conn.fetch("select id::text from webhook_events order by created_at")
        attempts_left = await conn.fetchval("select count(*) from webhook_attempts")
    assert [r["id"] for r in left] == [new_event]
    assert attempts_left == 1
    assert (
        await WebhookActivities(pool, encryption_keys=KEYS, retention_days=0).prune_webhooks() == 0
    )


async def test_key_rotation_reencrypts_old_secrets(pool: asyncpg.Pool) -> None:
    org_id = await new_org(pool)
    endpoint_id = await new_endpoint(
        pool, org_id, "https://hooks.example.com/in", previous_secret=OLD_SECRET
    )
    rotated = {"next": parse_keys("next:a-new-key-that-is-at-least-32-chars-long")["next"], **KEYS}
    moved = await WebhookActivities(pool, encryption_keys=rotated).reencrypt_webhook_secrets()
    assert moved >= 1
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        row = await conn.fetchrow(
            "select secret, previous_secret from webhook_endpoints where id = $1", endpoint_id
        )
    assert row is not None
    assert row["secret"].startswith("v1:next:") and row["previous_secret"].startswith("v1:next:")
    only_new = {"next": rotated["next"]}  # the old key can now be removed
    assert decrypt_secret(row["secret"], endpoint_id, only_new) == SECRET
    assert decrypt_secret(row["previous_secret"], endpoint_id, only_new) == OLD_SECRET
    assert SECRET not in row["secret"] and SECRET.removeprefix("whsec_") not in row["secret"]


async def test_maintenance_schedule_is_created_once(client: Client) -> None:
    schedule_id = f"test-webhook-maintenance-{uuid.uuid4()}"
    await ensure_maintenance_schedule(client, TASK_QUEUE, schedule_id)
    await ensure_maintenance_schedule(client, TASK_QUEUE, schedule_id)  # restart: no error
    handle = client.get_schedule_handle(schedule_id)
    description = await handle.describe()
    assert description.schedule.spec.intervals[0].every == timedelta(days=1)
    await handle.delete()
