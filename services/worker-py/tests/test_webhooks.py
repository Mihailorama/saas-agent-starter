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
from standardwebhooks import Webhook
from temporalio.client import Client
from temporalio.worker import Worker

from tests.conftest import new_org
from worker import settings
from worker.webhooks import (
    BlockedAddress,
    WebhookActivities,
    WebhookEvent,
    is_blocked,
    resolve_public,
    sign,
)
from worker.workflows import WebhookEventWorkflow

SECRET = "whsec_" + base64.b64encode(b"local-dev-webhook-secret").decode()
OLD_SECRET = "whsec_" + base64.b64encode(b"local-dev-rotated-secret").decode()
LOOPBACK = [ip_network("127.0.0.0/8"), ip_network("::1/128")]


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
    lenient = WebhookActivities(pool, allowed_networks=LOOPBACK, max_payload_bytes=2048)
    strict = WebhookActivities(pool)
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


async def setup_delivery(
    pool: asyncpg.Pool,
    url: str,
    *,
    payload: str | None = None,
    previous_secret: str | None = None,
) -> tuple[str, str, str]:
    """An endpoint, an event and its pending delivery, as publishEvent() writes them."""
    org_id = await new_org(pool)
    event_id = str(uuid.uuid4())
    body = payload or json.dumps(
        {"type": "project.created", "timestamp": "2026-11-07T00:00:00Z", "data": {"id": "p1"}}
    )
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        endpoint_id = await conn.fetchval(
            "insert into webhook_endpoints"
            " (org_id, url, event_types, secret, previous_secret, previous_secret_expires_at)"
            " values ($1, $2, $3, $4, $5, $6) returning id",
            org_id,
            url,
            ["project.created"],
            SECRET,
            previous_secret,
            datetime.now(UTC) + timedelta(hours=1) if previous_secret else None,
        )
        await conn.execute(
            "insert into webhook_events (id, org_id, type, payload) values ($1, $2, $3, $4)",
            event_id,
            org_id,
            "project.created",
            body,
        )
        delivery_id = await conn.fetchval(
            "insert into webhook_deliveries (org_id, event_id, endpoint_id)"
            " values ($1, $2, $3) returning id::text",
            org_id,
            event_id,
            endpoint_id,
        )
    return org_id, event_id, delivery_id


async def run(
    client: Client,
    org_id: str,
    event_id: str,
    delivery_id: str,
    *,
    queue: str = TASK_QUEUE,
    replay: bool = False,
) -> list[str]:
    return await client.execute_workflow(
        WebhookEventWorkflow.run,
        WebhookEvent(
            orgId=org_id,
            eventId=event_id,
            deliveryIds=[delivery_id],
            replay=replay,
            retryInitialSeconds=0.2,
            maxAttempts=3,
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
