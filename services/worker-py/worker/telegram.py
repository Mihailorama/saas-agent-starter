"""Lite Telegram support (docs/support.md "Lite: Telegram only", ADR 0013).

Users write to the bot; each Telegram user gets one forum topic in the team's supergroup
(TELEGRAM_SUPPORT_CHAT_ID) and their messages are copied there (copyMessage: media included). The
team answers in the topic and the bot copies the answer back. We store only the user <-> topic
mapping (table telegram_support_users) and the app user linked by the Help menu's deep link;
message content stays in Telegram. `/bug` and `/feature` in a topic file a tracker item with the
Chatwoot triage's producers (worker/support.py) through the one tracker client. Plain Bot API over
httpx2: five methods do not need a bot framework.
"""

import asyncio
import base64
import hashlib
import hmac
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

import asyncpg
import httpx2
from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker.support import FILED, scrub
from worker.tracker import Tracker, find_open

log = logging.getLogger(__name__)

# Sent to a new user and on /start, by the user's Telegram language. Edit for your audience.
ACK = {
    "en": "We got your message. The team will answer here, usually within one working day.",
    "ru": "Мы получили ваше сообщение. Команда ответит здесь, обычно в течение рабочего дня.",
}
REACTION = "👍"  # on every relayed message: "received", in any language
TOPIC_URL = re.compile(r"https://t\.me/c/(\d+)/(\d+)")


@dataclass(frozen=True)
class TelegramUpdate:
    """Workflow input. Contract with apps/api/src/temporal.ts: ids, `arg` already redacted."""

    chatId: int
    messageId: int
    fromId: int
    threadId: int = 0
    command: str = ""  # start | bug | feature | other | "" (a message to relay)
    arg: str = ""
    lang: str = ""


def key(token: str, purpose: str) -> str:
    """Twin of telegramKey() in apps/api/src/routes/support.ts."""
    msg = f"telegram-support-{purpose}".encode()
    return hmac.new(token.encode(), msg, hashlib.sha256).hexdigest()


def start_user(token: str, payload: str, now: float | None = None) -> str | None:
    """The app user id in a valid deep-link payload (telegramStartToken() in the API)."""
    exp, _, rest = payload.partition("_")
    sig, sep, user_id = rest[:16], rest[16:17], rest[17:]
    if sep != "_" or not user_id or not re.fullmatch(r"[0-9a-z]{1,12}", exp):
        return None
    mac = hmac.new(key(token, "link").encode(), f"{exp}.{user_id}".encode(), hashlib.sha256)
    want = base64.urlsafe_b64encode(mac.digest()).decode()[:16]
    if not hmac.compare_digest(sig, want) or int(exp, 36) < (now or time.time()):
        return None
    return user_id


def topic_link(chat_id: int, topic_id: int) -> str:
    """Link to the topic for team members; the return path finds topics by it."""
    return f"https://t.me/c/{str(chat_id).removeprefix('-100')}/{topic_id}"


class BotError(Exception):
    """A Bot API call failed: Telegram's description, never the URL (it contains the token)."""

    def __init__(self, method: str, status: int, description: str = "") -> None:
        super().__init__(f"telegram {method}: {status} {description}".strip())
        self.status, self.description = status, description


class Bot:
    def __init__(self, token: str, http: httpx2.AsyncClient, api_url: str) -> None:
        self.base, self.http = f"{api_url.rstrip('/')}/bot{token}", http

    async def __call__(self, method: str, **params: Any) -> Any:
        try:
            res = await self.http.post(f"{self.base}/{method}", json=params)
            body: dict[str, Any] = res.json()
        except (httpx2.HTTPError, ValueError) as e:
            raise BotError(method, 0, type(e).__name__) from None
        if not body.get("ok"):
            raise BotError(method, res.status_code, str(body.get("description", ""))[:200])
        return body["result"]


class TelegramActivities:
    def __init__(
        self, *, bot: Bot, token: str, chat_id: int, pool: asyncpg.Pool, tracker: Tracker
    ) -> None:
        self.bot, self.token, self.chat_id = bot, token, chat_id
        self.pool, self.tracker = pool, tracker

    async def register_webhook(self, url: str) -> None:
        secret = key(self.token, "webhook")
        await self.bot("setWebhook", url=url, secret_token=secret, allowed_updates=["message"])

    @activity.defn(name="telegram_support_update")
    async def handle(self, u: TelegramUpdate) -> str:
        """Relays one message. ponytail: one workflow per message, so two messages sent within
        the same second can arrive swapped; a per-user workflow with signals if that matters."""
        try:
            return await (self._from_team(u) if u.chatId == self.chat_id else self._from_user(u))
        except BotError as e:  # a 4xx will not get better by retrying (429 does)
            if 400 <= e.status < 500 and e.status != 429:
                raise ApplicationError(str(e), non_retryable=True) from None
            raise

    async def _from_user(self, u: TelegramUpdate) -> str:
        topic, new = await self._topic(u.fromId)
        if u.command == "start":
            if user_id := start_user(self.token, u.arg):
                await self._link(u.fromId, topic, user_id)
            await self._ack(u)
            return "start"
        try:
            await self._copy(u, topic)
        except BotError as e:
            if "thread not found" not in e.description:
                raise
            topic, new = await self._topic(u.fromId, stale=topic)  # the team deleted the topic
            await self._copy(u, topic)
        try:
            reaction = [{"type": "emoji", "emoji": REACTION}]
            await self.bot(
                "setMessageReaction", chat_id=u.chatId, message_id=u.messageId, reaction=reaction
            )
        except BotError as e:  # best effort: a retry would copy the message twice
            log.warning("telegram reaction failed: %s", e)
        if new:
            await self._ack(u)
        return "to-team"

    async def _from_team(self, u: TelegramUpdate) -> str:
        row = await self.pool.fetchrow(
            "select telegram_user_id, user_id from telegram_support_users"
            " where chat_id = $1 and topic_id = $2",
            self.chat_id,
            u.threadId,
        )
        if row is None:
            return "unknown-topic"
        if u.command in ("bug", "feature"):
            return await self._file(u, row["user_id"])
        if u.command:
            return "ignored"  # other commands stay in the team's group
        try:
            await self.bot(
                "copyMessage",
                chat_id=row["telegram_user_id"],
                from_chat_id=u.chatId,
                message_id=u.messageId,
            )
        except BotError as e:
            if not 400 <= e.status < 500 or e.status == 429:
                raise
            await self._note(u.threadId, f"Not delivered ({e.description or e.status}).")
            return "not-delivered"
        return "to-user"

    async def _topic(self, tg_user: int, stale: int = 0) -> tuple[int, bool]:
        """The user's topic, created on first contact (or when the team deleted it)."""
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select pg_advisory_xact_lock($1)", tg_user)  # one topic per user
            topic: int | None = await conn.fetchval(
                "select topic_id from telegram_support_users"
                " where telegram_user_id = $1 and chat_id = $2",
                tg_user,
                self.chat_id,
            )
            if topic and topic != stale:
                return topic, False
            name = await self._name(tg_user)
            created = await self.bot("createForumTopic", chat_id=self.chat_id, name=name)
            topic = int(created["message_thread_id"])
            await conn.execute(
                "insert into telegram_support_users (telegram_user_id, chat_id, topic_id)"
                " values ($1, $2, $3) on conflict (telegram_user_id)"
                " do update set chat_id = excluded.chat_id, topic_id = excluded.topic_id",
                tg_user,
                self.chat_id,
                topic,
            )
            return topic, True

    async def _name(self, tg_user: int) -> str:
        """Topic title: the user's Telegram name and id (lives in Telegram, not with us)."""
        try:
            chat: dict[str, Any] = await self.bot("getChat", chat_id=tg_user)
        except BotError:
            chat = {}
        name = " ".join(str(chat[k]) for k in ("first_name", "last_name") if chat.get(k))
        handle = f" @{chat['username']}" if chat.get("username") else ""
        return f"{name or 'User'}{handle} · {tg_user}"[:128]

    async def _link(self, tg_user: int, topic: int, user_id: str) -> None:
        try:
            await self.pool.execute(
                "update telegram_support_users set user_id = $2 where telegram_user_id = $1",
                tg_user,
                user_id,
            )
        except asyncpg.ForeignKeyViolationError:
            return  # the account was deleted since the link was made
        orgs = await self.pool.fetch(
            "select organization_id from member where user_id = $1 limit 5", user_id
        )
        ids = ", ".join(r["organization_id"] for r in orgs) or "none"
        await self._note(topic, f"Linked to app user {user_id} (organizations: {ids}).")

    async def _file(self, u: TelegramUpdate, user_id: str | None) -> str:
        """`/bug <title>` or `/feature <title>`: a "+1" on the open item with that title, or a
        new item (producers support-bug / support-feature-request, config/tracker.json)."""
        category = "bug" if u.command == "bug" else "feature_request"
        title = (await asyncio.to_thread(scrub, u.arg, 120)).strip()
        if not title:
            await self._note(u.threadId, f"Usage: /{u.command} <short title>")
            return "usage"
        link = topic_link(self.chat_id, u.threadId)
        if existing := await find_open(self.tracker, title):
            await self.tracker.comment(existing.ref, f"+1 user\n\nSupport conversation: {link}")
            item, verb = existing, "Added as +1 to"
        else:
            body = [title, "", f"- Category: {category}", f"- Support conversation: {link}"]
            body += [f"- App user: {user_id}"] if user_id else []
            body += [
                "",
                "---",
                "For the agent: filed from the Telegram support group (docs/support.md). The",
                "topic link is how the reporter is told when this closes; keep it in the issue.",
            ]
            item = await self.tracker.create(FILED[category], title, "\n".join(body))
            verb = "Filed"
        await self._note(u.threadId, f"{verb}: {item.url or f'(dry run, {self.tracker.name})'}")
        return category

    async def notify_closed(self, texts: list[str], note: str, tell: str) -> int:
        """Return path (SupportIssueClosedWorkflow): a note in every linked topic of our group
        and, when `tell` is set, that message to the user."""
        ours = str(self.chat_id).removeprefix("-100")
        topics = sorted({int(t) for x in texts for c, t in TOPIC_URL.findall(x) if c == ours})
        for topic in topics:
            await self._note(topic, note)
            user = await self.pool.fetchval(
                "select telegram_user_id from telegram_support_users"
                " where chat_id = $1 and topic_id = $2",
                self.chat_id,
                topic,
            )
            if tell and user:
                await self.bot("sendMessage", chat_id=user, text=tell)
        return len(topics)

    async def _copy(self, u: TelegramUpdate, topic: int) -> None:
        await self.bot(
            "copyMessage",
            chat_id=self.chat_id,
            message_thread_id=topic,
            from_chat_id=u.chatId,
            message_id=u.messageId,
        )

    async def _ack(self, u: TelegramUpdate) -> None:
        await self.bot("sendMessage", chat_id=u.chatId, text=ACK.get(u.lang[:2], ACK["en"]))

    async def _note(self, topic: int, text: str) -> None:
        await self.bot("sendMessage", chat_id=self.chat_id, message_thread_id=topic, text=text)
