"""Lite Telegram support: relay both ways, topics, links, /bug, ordering, against a fake Bot API.

The Bot API is an httpx2 mock transport (no network, no real bot); Postgres, S3 and Temporal are
the compose ones.
"""

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from secrets import randbelow
from typing import Any

import asyncpg
import httpx2
import pytest
from temporalio.client import Client
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker

from worker import settings
from worker.s3 import S3
from worker.telegram import (
    REACTION,
    TEXTS,
    Bot,
    TelegramActivities,
    TelegramChat,
    TelegramUpdate,
    key,
    topic_link,
)
from worker.tracker import DryRunTracker, Item, Status
from worker.workflows import TelegramChatWorkflow

TOKEN = "123456:local-dev-token"  # noqa: S105 (a fake, the Bot API is mocked)


class FakeBotApi:
    """Records every call; `fail` maps a method to Telegram errors to answer, in order."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail: dict[str, list[tuple[int, str, dict[str, Any]]]] = {}
        self.topics = 100

    def handle(self, req: httpx2.Request) -> httpx2.Response:
        assert req.url.path.startswith(f"/bot{TOKEN}/")
        method, params = req.url.path.rsplit("/", 1)[1], json.loads(req.content)
        self.calls.append((method, params))
        if self.fail.get(method):
            code, description, extra = self.fail[method].pop(0)
            body = {"ok": False, "error_code": code, "description": description, **extra}
            return httpx2.Response(code, json=body)
        result: Any = True
        if method == "getChat":
            result = {"id": params["chat_id"], "first_name": "Ana", "username": "ana"}
        elif method == "createForumTopic":
            self.topics += 1
            result = {"message_thread_id": self.topics, "name": params["name"]}
        elif method in ("copyMessage", "sendMessage"):
            result = {"message_id": 1}
        return httpx2.Response(200, json={"ok": True, "result": result})

    def named(self, method: str) -> list[dict[str, Any]]:
        return [p for m, p in self.calls if m == method]


class RecordingTracker(DryRunTracker):
    """Dry run that remembers its items, so duplicates and "+1"s can be checked."""

    def __init__(self) -> None:
        self.items: dict[str, tuple[str, str, list[str]]] = {}  # ref -> producer, title, texts

    async def search(self, query: str) -> list[Item]:
        return [Item(ref, "", title) for ref, (_, title, _) in self.items.items()]

    async def create(self, producer: str, title: str, body: str) -> Item:
        ref = f"item-{len(self.items) + 1}"
        self.items[ref] = (producer, title, [body])
        return Item(ref, f"https://tracker.example.com/{ref}", title)

    async def comment(self, ref: str, body: str) -> None:
        self.items[ref][2].append(body)

    async def read(self, ref: str) -> Status | None:
        return Status("", "open", self.items[ref][2])


@pytest.fixture
def fake() -> FakeBotApi:
    return FakeBotApi()


@pytest.fixture(scope="session")
async def files() -> AsyncIterator[S3]:
    s3 = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.S3_BUCKET,
    )
    await s3.ensure_bucket()
    yield s3
    await s3.close()


@pytest.fixture
async def tg(pool: asyncpg.Pool, fake: FakeBotApi, files: S3) -> TelegramActivities:
    http = httpx2.AsyncClient(transport=httpx2.MockTransport(fake.handle))
    group = -1000000000000 - randbelow(10**9)  # own group per test: no clashes on reruns
    return TelegramActivities(
        bot=Bot(TOKEN, http, "http://bot-api.test"),
        token=TOKEN,
        chat_id=group,
        pool=pool,
        tracker=RecordingTracker(),
        files=files,
    )


async def relay(tg: TelegramActivities, u: TelegramUpdate) -> None:
    """What TelegramChatWorkflow does for one message, without Temporal."""
    steps = ["main"]
    while steps:
        steps = [*await tg.handle(u, steps[0]), *steps[1:]]


def from_user(user: int, message_id: int, **kw: Any) -> TelegramUpdate:
    return TelegramUpdate(chatId=user, messageId=message_id, fromId=user, **kw)


def from_team(tg: TelegramActivities, message_id: int, topic: int, **kw: Any) -> TelegramUpdate:
    return TelegramUpdate(chatId=tg.chat_id, messageId=message_id, fromId=555, threadId=topic, **kw)


async def test_user_to_topic_and_back(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    await relay(tg, from_user(user, 5, lang="ru"))
    [topic] = fake.named("createForumTopic")
    assert topic == {"chat_id": tg.chat_id, "name": f"Ana @ana · {user}"}
    assert fake.named("copyMessage") == [
        {"chat_id": tg.chat_id, "message_thread_id": 101, "from_chat_id": user, "message_id": 5}
    ]
    reaction = [{"type": "emoji", "emoji": REACTION}]
    assert fake.named("setMessageReaction") == [
        {"chat_id": user, "message_id": 5, "reaction": reaction}
    ]
    assert fake.named("sendMessage") == [{"chat_id": user, "text": TEXTS["ru"]["ack"]}]

    # Second message: same topic, no second acknowledgement.
    await relay(tg, from_user(user, 6))
    assert len(fake.named("createForumTopic")) == 1
    assert fake.named("copyMessage")[-1]["message_thread_id"] == 101
    assert len(fake.named("sendMessage")) == 1

    # The team answers in the topic: copied to the user's private chat.
    await relay(tg, from_team(tg, 77, 101))
    assert fake.named("copyMessage")[-1] == {
        "chat_id": user,
        "from_chat_id": tg.chat_id,
        "message_id": 77,
    }
    # A topic we do not know and other commands are not relayed.
    await relay(tg, from_team(tg, 78, 999))
    await relay(tg, from_team(tg, 79, 101, command="other"))
    assert len(fake.named("copyMessage")) == 3


async def test_steps_retry_alone(tg: TelegramActivities, fake: FakeBotApi) -> None:
    """A failing acknowledgement is retried on its own: the copy is not repeated."""
    user = randbelow(10**9)
    u = from_user(user, 1)
    assert await tg.handle(u, "main") == ["react", "ack"]
    await tg.handle(u, "react")
    fake.fail["sendMessage"] = [
        (429, "Too Many Requests: retry after 7", {"parameters": {"retry_after": 7}})
    ]
    with pytest.raises(ApplicationError) as err:
        await tg.handle(u, "ack")
    assert err.value.next_retry_delay == timedelta(seconds=7) and not err.value.non_retryable
    assert await tg.handle(u, "ack") == []
    assert len(fake.named("copyMessage")) == 1
    # A 4xx other than 429 is not retried.
    fake.fail["sendMessage"] = [(400, "Bad Request: chat not found", {})]
    with pytest.raises(ApplicationError) as err:
        await tg.handle(u, "ack")
    assert err.value.non_retryable


async def test_deleted_and_closed_topics(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    await relay(tg, from_user(user, 1))
    fake.fail["copyMessage"] = [(400, "Bad Request: message thread not found", {})]
    await relay(tg, from_user(user, 2))
    assert [c["message_thread_id"] for c in fake.named("copyMessage")] == [101, 101, 102]
    row = await tg.pool.fetchval(
        "select topic_id from telegram_support_users where telegram_user_id = $1", user
    )
    assert row == 102
    # The team closed the topic: reopened, then the message goes in.
    fake.fail["copyMessage"] = [(400, "Bad Request: TOPIC_CLOSED", {})]
    await relay(tg, from_user(user, 3))
    assert fake.named("reopenForumTopic") == [{"chat_id": tg.chat_id, "message_thread_id": 102}]
    assert fake.named("copyMessage")[-1]["message_id"] == 3


async def test_undeliverable_reply_is_noted(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    await relay(tg, from_user(user, 1))
    fake.fail["copyMessage"] = [(403, "Forbidden: bot was blocked by the user", {})]
    await relay(tg, from_team(tg, 9, 101))
    note = fake.named("sendMessage")[-1]
    assert note["message_thread_id"] == 101 and "blocked" in note["text"]


async def test_start_links_the_app_user(
    tg: TelegramActivities, fake: FakeBotApi, pool: asyncpg.Pool
) -> None:
    user_id = f"tg-test-{randbelow(10**9)}"
    await pool.execute(
        'insert into "user" (id, name, email, email_verified, created_at, updated_at)'
        " values ($1, 'T', 'jane@example.com', true, now(), now())",
        user_id,
    )
    user = randbelow(10**9)
    await relay(tg, from_user(user, 1, command="start", userId=user_id))  # verified by the API
    linked = "select user_id from telegram_support_users where telegram_user_id = $1"
    assert await pool.fetchval(linked, user) == user_id
    told, note = fake.named("sendMessage")
    assert told == {"chat_id": user, "text": TEXTS["en"]["linked"].format(email="j***@example.com")}
    assert note["message_thread_id"] == 101 and f"app user {user_id}" in note["text"]
    # A link the API refused: the user is told, nothing changes.
    await relay(tg, from_user(user, 2, command="start", linkFailed=True))
    assert fake.named("sendMessage")[-1]["text"] == TEXTS["en"]["link-failed"]
    # Deleting the account deletes the mapping (privacy deletion relies on the cascade).
    await pool.execute('delete from "user" where id = $1', user_id)
    assert await pool.fetchval(linked, user) is None


def test_webhook_secret_matches_the_api() -> None:
    # telegramKey('123456:local-dev-token', 'webhook') in apps/api/src/routes/support.ts.
    assert key(TOKEN, "webhook") == (
        "b91366965c84666c1b9af169a34c8fc0a4d9374eb9d93da189522498c04ec52d"
    )


async def test_bug_command_files_once(tg: TelegramActivities, fake: FakeBotApi, files: S3) -> None:
    user = randbelow(10**9)
    await relay(tg, from_user(user, 1))
    s3_key = f"tracker-inbox/telegram-test-{uuid.uuid4()}.json"
    await files.put(s3_key, json.dumps({"title": "Export fails for [email]"}).encode())
    bug = from_team(tg, 50, 101, command="bug", s3Key=s3_key)
    await relay(tg, bug)
    tracker = tg.tracker
    assert isinstance(tracker, RecordingTracker)
    [(producer, title, [body])] = tracker.items.values()
    assert producer == "support-bug"  # same producer as the Chatwoot triage
    assert title == "Export fails for [email]"
    assert f"Support conversation: {topic_link(tg.chat_id, 101)}" in body
    assert fake.named("sendMessage")[-1]["text"] == "Filed: https://tracker.example.com/item-1"
    # A retry after the item was filed: nothing more.
    assert await tg.handle(bug, "main") == []
    # The same title from this topic again: no "+1" on its own item; from another topic: "+1".
    await files.put(s3_key, json.dumps({"title": title}).encode())
    await relay(tg, bug)
    assert len(tracker.items["item-1"][2]) == 1
    other = randbelow(10**9)
    await relay(tg, from_user(other, 1))
    await files.put(s3_key, json.dumps({"title": title}).encode())
    await relay(tg, from_team(tg, 60, 102, command="bug", s3Key=s3_key))
    assert len(tracker.items) == 1 and "+1 user" in tracker.items["item-1"][2][1]
    # No title: usage hint, nothing filed.
    await files.put(s3_key, json.dumps({"title": ""}).encode())
    await relay(tg, from_team(tg, 51, 101, command="bug", s3Key=s3_key))
    assert fake.named("sendMessage")[-1]["text"] == "Usage: /bug <short title>"


async def test_return_path_notes_linked_topics(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    await relay(tg, from_user(user, 1))
    texts = [f"Bug\n\n- Support conversation: {topic_link(tg.chat_id, 101)}"]
    assert await tg.notify_closed(texts, "Linked issue X was resolved.", "Resolved!") == 1
    note, told = fake.named("sendMessage")[-2:]
    assert note == {
        "chat_id": tg.chat_id,
        "message_thread_id": 101,
        "text": "Linked issue X was resolved.",
    }
    assert told == {"chat_id": user, "text": "Resolved!"}
    assert await tg.notify_closed(["https://t.me/c/42/101"], "x", "") == 0  # not our group


async def test_chat_workflow_keeps_order_and_drops_redeliveries(
    tg: TelegramActivities, fake: FakeBotApi
) -> None:
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    queue, user = f"test-{uuid.uuid4()}", randbelow(10**9)
    async with Worker(
        client, task_queue=queue, workflows=[TelegramChatWorkflow], activities=[tg.handle]
    ):
        for message_id in (1, 2, 2, 3):  # 2 twice: Telegram redelivered it
            await client.start_workflow(
                TelegramChatWorkflow.run,
                TelegramChat([], []),
                id=f"telegram-chat-{user}-0",
                task_queue=queue,
                start_signal="message",
                start_signal_args=[from_user(user, message_id)],
            )
        for _ in range(100):
            if len(fake.named("copyMessage")) >= 3 and len(fake.named("setMessageReaction")) >= 3:
                break
            await asyncio.sleep(0.1)
        await client.get_workflow_handle(f"telegram-chat-{user}-0").terminate("test cleanup")
    assert [c["message_id"] for c in fake.named("copyMessage")] == [1, 2, 3]
