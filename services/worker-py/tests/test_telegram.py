"""Lite Telegram support: relay both ways, topics, deep link, /bug, against a fake Bot API.

The Bot API is an httpx2 mock transport (no network, no real bot); Postgres is the compose one.
"""

import base64
import hashlib
import hmac
import json
from secrets import randbelow
from typing import Any

import asyncpg
import httpx2
import pytest

from worker.telegram import (
    ACK,
    REACTION,
    Bot,
    TelegramActivities,
    TelegramUpdate,
    key,
    start_user,
    topic_link,
)
from worker.tracker import DryRunTracker, Item

TOKEN = "123456:local-dev-token"  # noqa: S105 (a fake, the Bot API is mocked)


class FakeBotApi:
    """Records every call; `fail` maps a method to a Telegram error description (400)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail: dict[str, str] = {}
        self.topics = 100

    def handle(self, req: httpx2.Request) -> httpx2.Response:
        assert req.url.path.startswith(f"/bot{TOKEN}/")
        method, params = req.url.path.rsplit("/", 1)[1], json.loads(req.content)
        self.calls.append((method, params))
        if method in self.fail:
            body = {"ok": False, "error_code": 400, "description": self.fail.pop(method)}
            return httpx2.Response(400, json=body)
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
    def __init__(self) -> None:
        self.created: list[tuple[str, str, str]] = []

    async def create(self, producer: str, title: str, body: str) -> Item:
        self.created.append((producer, title, body))
        return await super().create(producer, title, body)


@pytest.fixture
def fake() -> FakeBotApi:
    return FakeBotApi()


@pytest.fixture
async def tg(pool: asyncpg.Pool, fake: FakeBotApi) -> TelegramActivities:
    http = httpx2.AsyncClient(transport=httpx2.MockTransport(fake.handle))
    group = -1000000000000 - randbelow(10**9)  # own group per test: no clashes on reruns
    bot = Bot(TOKEN, http, "http://bot-api.test")
    return TelegramActivities(
        bot=bot, token=TOKEN, chat_id=group, pool=pool, tracker=RecordingTracker()
    )


def user_message(user: int, message_id: int, **kw: Any) -> TelegramUpdate:
    return TelegramUpdate(chatId=user, messageId=message_id, fromId=user, **kw)


async def test_user_to_topic_and_back(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    assert await tg.handle(user_message(user, 5, lang="ru")) == "to-team"
    [topic] = fake.named("createForumTopic")
    assert topic == {"chat_id": tg.chat_id, "name": f"Ana @ana · {user}"}
    assert fake.named("copyMessage") == [
        {"chat_id": tg.chat_id, "message_thread_id": 101, "from_chat_id": user, "message_id": 5}
    ]
    reaction = [{"type": "emoji", "emoji": REACTION}]
    assert fake.named("setMessageReaction") == [
        {"chat_id": user, "message_id": 5, "reaction": reaction}
    ]
    assert fake.named("sendMessage") == [{"chat_id": user, "text": ACK["ru"]}]  # first contact

    # Second message: same topic, no second acknowledgement.
    assert await tg.handle(user_message(user, 6)) == "to-team"
    assert len(fake.named("createForumTopic")) == 1
    assert fake.named("copyMessage")[-1]["message_thread_id"] == 101
    assert len(fake.named("sendMessage")) == 1

    # The team answers in the topic: copied to the user's private chat.
    reply = TelegramUpdate(chatId=tg.chat_id, messageId=77, fromId=555, threadId=101)
    assert await tg.handle(reply) == "to-user"
    assert fake.named("copyMessage")[-1] == {
        "chat_id": user,
        "from_chat_id": tg.chat_id,
        "message_id": 77,
    }
    # A topic we do not know and other commands are not relayed.
    other = TelegramUpdate(chatId=tg.chat_id, messageId=78, fromId=555, threadId=999)
    assert await tg.handle(other) == "unknown-topic"
    cmd = TelegramUpdate(chatId=tg.chat_id, messageId=79, fromId=555, threadId=101, command="other")
    assert await tg.handle(cmd) == "ignored"
    assert len(fake.named("copyMessage")) == 3


async def test_deleted_topic_is_recreated(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    await tg.handle(user_message(user, 1))
    fake.fail["copyMessage"] = "Bad Request: message thread not found"
    assert await tg.handle(user_message(user, 2)) == "to-team"
    assert [c["message_thread_id"] for c in fake.named("copyMessage")] == [101, 101, 102]
    row = await tg.pool.fetchval(
        "select topic_id from telegram_support_users where telegram_user_id = $1", user
    )
    assert row == 102


async def test_undeliverable_reply_is_noted(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    await tg.handle(user_message(user, 1))
    fake.fail["copyMessage"] = "Forbidden: bot was blocked by the user"
    reply = TelegramUpdate(chatId=tg.chat_id, messageId=9, fromId=555, threadId=101)
    assert await tg.handle(reply) == "not-delivered"
    note = fake.named("sendMessage")[-1]
    assert note["message_thread_id"] == 101 and "blocked" in note["text"]


async def test_deep_link_links_the_app_user(
    tg: TelegramActivities, fake: FakeBotApi, pool: asyncpg.Pool
) -> None:
    user_id = f"tg-test-{randbelow(10**9)}"
    await pool.execute(
        'insert into "user" (id, name, email, email_verified, created_at, updated_at)'
        " values ($1, 'T', $1 || '@example.com', true, now(), now())",
        user_id,
    )
    payload = tg_token(user_id)
    user = randbelow(10**9)
    start = user_message(user, 1, command="start", arg=payload)
    assert await tg.handle(start) == "start"
    linked = await pool.fetchval(
        "select user_id from telegram_support_users where telegram_user_id = $1", user
    )
    assert linked == user_id
    assert any(f"app user {user_id}" in c["text"] for c in fake.named("sendMessage"))
    # Deleting the account deletes the mapping (privacy deletion relies on the cascade).
    await pool.execute('delete from "user" where id = $1', user_id)
    gone = "select count(*) from telegram_support_users where telegram_user_id = $1"
    assert await pool.fetchval(gone, user) == 0


def tg_token(user_id: str, exp: int = 2**40) -> str:
    """Same construction as telegramStartToken() in the API (checked against it below)."""
    e = _b36(exp)
    mac = hmac.new(key(TOKEN, "link").encode(), f"{e}.{user_id}".encode(), hashlib.sha256)
    return f"{e}_{base64.urlsafe_b64encode(mac.digest()).decode()[:16]}_{user_id}"


def _b36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"


def test_start_token_matches_the_api() -> None:
    # Printed by telegramStartToken('123456:local-dev-token', <id>, 1794150000000) in the API.
    api = "to8po0_kgtmOtzIkMbOzk2d_user1234567890abcdefghijklmnopqr"
    assert start_user(TOKEN, api, now=1794150000) == "user1234567890abcdefghijklmnopqr"
    assert start_user(TOKEN, api, now=1794150000 + 2 * 86400) is None  # expired
    assert start_user(TOKEN, api.replace("_user", "_usex"), now=1794150000) is None
    assert start_user("other:token", api, now=1794150000) is None
    assert start_user(TOKEN, "garbage", now=1794150000) is None
    # The webhook secret: same derivation as telegramKey() in the API.
    assert key(TOKEN, "webhook") == (
        "b91366965c84666c1b9af169a34c8fc0a4d9374eb9d93da189522498c04ec52d"
    )


async def test_bug_command_files_a_redacted_item(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    await tg.handle(user_message(user, 1))
    bug = TelegramUpdate(
        chatId=tg.chat_id,
        messageId=50,
        fromId=555,
        threadId=101,
        command="bug",
        arg="Export fails for jane.doe@example.com",
    )
    assert await tg.handle(bug) == "bug"
    tracker = tg.tracker
    assert isinstance(tracker, RecordingTracker)
    [(producer, title, body)] = tracker.created
    assert producer == "support-bug"  # same producer as the Chatwoot triage
    assert title == "Export fails for [email]"
    assert f"Support conversation: {topic_link(tg.chat_id, 101)}" in body
    assert "jane.doe" not in body
    assert fake.named("sendMessage")[-1]["text"] == "Filed: (dry run, dry-run)"
    # No title: usage hint, nothing filed.
    empty = TelegramUpdate(chatId=tg.chat_id, messageId=51, fromId=5, threadId=101, command="bug")
    assert await tg.handle(empty) == "usage"
    assert len(tracker.created) == 1


async def test_return_path_notes_linked_topics(tg: TelegramActivities, fake: FakeBotApi) -> None:
    user = randbelow(10**9)
    await tg.handle(user_message(user, 1))
    texts = [f"Bug\n\n- Support conversation: {topic_link(tg.chat_id, 101)}"]
    assert await tg.notify_closed(texts, "Linked issue X was resolved.", "Resolved!") == 1
    note, told = fake.named("sendMessage")[-2:]
    assert note == {
        "chat_id": tg.chat_id,
        "message_thread_id": 101,
        "text": "Linked issue X was resolved.",
    }
    assert told == {"chat_id": user, "text": "Resolved!"}
    # Another group's topic links are not ours.
    assert await tg.notify_closed(["https://t.me/c/42/101"], "x", "") == 0
