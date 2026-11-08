"""Lite Telegram support (docs/support.md "Lite: Telegram only", ADR 0013).

Users write to the bot; each Telegram user gets one forum topic in the team's supergroup
(TELEGRAM_SUPPORT_CHAT_ID) and their messages are copied there (copyMessage: media included). The
team answers in the topic and the bot copies the answer back. We store only the user <-> topic
mapping (table telegram_support_users) and the app user linked by the Help menu's deep link (the
API verifies it); message content stays in Telegram. `/bug` and `/feature` in a topic file a
tracker item with the Chatwoot triage's producers (worker/support.py). Plain Bot API over httpx2.

Each message is handled in steps (`main` first, then the steps it returns: reaction, replies,
notes), one activity each, so a retry repeats only the step that failed (TelegramChatWorkflow).
"""

import hashlib
import hmac
import json
import logging
import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import asyncpg
import httpx2
from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker.s3 import S3, NotFound
from worker.support import FILED
from worker.tracker import Tracker, find_open, obj

log = logging.getLogger(__name__)

# What the bot says to users, by their Telegram language. Edit for your audience.
TEXTS = {
    "en": {
        "ack": "We got your message. The team will answer here, usually within one working day.",
        "linked": "Done: this chat is now linked to your account {email}.",
        "link-failed": "This link has expired or was already used. Open Help -> Telegram again.",
    },
    "ru": {
        "ack": "Мы получили ваше сообщение. Команда ответит здесь, обычно в течение рабочего дня.",
        "linked": "Готово: этот чат теперь привязан к вашему аккаунту {email}.",
        "link-failed": "Ссылка устарела или уже использована. Откройте «Помощь -> Telegram» снова.",
    },
}
REACTION = "👍"  # on every relayed message: "received", in any language
TOPIC_URL = re.compile(r"https://t\.me/c/(\d+)/(\d+)")


@dataclass(frozen=True)
class TelegramUpdate:
    """Signal input. Contract with apps/api/src/temporal.ts: ids only."""

    chatId: int
    messageId: int
    fromId: int
    threadId: int = 0
    command: str = ""  # start | bug | feature | other | "" (a message to relay)
    userId: str = ""  # app user of a verified /start link
    linkFailed: bool = False
    s3Key: str = ""  # /bug, /feature: the redacted title, in S3
    lang: str = ""


@dataclass(frozen=True)
class TelegramChat:
    """TelegramChatWorkflow input: what a continued-as-new run carries over."""

    pending: list[TelegramUpdate]
    seen: list[int]


def key(token: str, purpose: str) -> str:
    """Twin of telegramKey() in apps/api/src/routes/support.ts."""
    msg = f"telegram-support-{purpose}".encode()
    return hmac.new(token.encode(), msg, hashlib.sha256).hexdigest()


def topic_link(chat_id: int, topic_id: int) -> str:
    """Link to the topic for team members; the return path finds topics by it."""
    return f"https://t.me/c/{str(chat_id).removeprefix('-100')}/{topic_id}"


def masked(email: str) -> str:
    name, _, domain = email.partition("@")
    return f"{name[:1]}***@{domain}" if domain else "***"


class BotError(Exception):
    """A Bot API call failed: Telegram's description, never the URL (it contains the token)."""

    def __init__(self, method: str, status: int, description: str = "", retry_after: int = 0):
        super().__init__(f"telegram {method}: {status} {description}".strip())
        self.status, self.description, self.retry_after = status, description, retry_after


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
            wait = int(obj(body.get("parameters")).get("retry_after") or 0)
            raise BotError(method, res.status_code, str(body.get("description", ""))[:200], wait)
        return body["result"]


class TelegramActivities:
    def __init__(
        self,
        *,
        bot: Bot,
        token: str,
        chat_id: int,
        pool: asyncpg.Pool,
        tracker: Tracker,
        files: S3,
    ) -> None:
        self.bot, self.token, self.chat_id = bot, token, chat_id
        self.pool, self.tracker, self.files = pool, tracker, files

    async def register_webhook(self, url: str) -> None:
        # One connection: Telegram then delivers updates one after the other, in order.
        secret = key(self.token, "webhook")
        await self.bot(
            "setWebhook",
            url=url,
            secret_token=secret,
            allowed_updates=["message"],
            max_connections=1,
        )

    @activity.defn(name="telegram_support_step")
    async def handle(self, u: TelegramUpdate, step: str) -> list[str]:
        """Runs one step of a message; returns the steps that follow it."""
        try:
            if step == "main":
                return await (
                    self._from_team(u) if u.chatId == self.chat_id else self._from_user(u)
                )
            await self._step(u, step)
            return []
        except BotError as e:
            if e.status == 429:  # Telegram says how long to wait
                delay = timedelta(seconds=e.retry_after or 5)
                raise ApplicationError(str(e), next_retry_delay=delay) from None
            if 400 <= e.status < 500:  # will not get better by retrying
                raise ApplicationError(str(e), non_retryable=True) from None
            raise

    async def _step(self, u: TelegramUpdate, step: str) -> None:
        text = TEXTS.get(u.lang[:2], TEXTS["en"])
        if step == "react":
            reaction = [{"type": "emoji", "emoji": REACTION}]
            try:
                await self.bot(
                    "setMessageReaction",
                    chat_id=u.chatId,
                    message_id=u.messageId,
                    reaction=reaction,
                )
            except BotError as e:  # cosmetic: never worth a retry loop
                log.warning("telegram reaction failed: %s", e)
        elif step in ("ack", "link-failed"):
            await self.bot("sendMessage", chat_id=u.chatId, text=text[step])
        elif step == "linked":
            email = await self.pool.fetchval('select email from "user" where id = $1', u.userId)
            msg = text["linked"].format(email=masked(email or ""))
            await self.bot("sendMessage", chat_id=u.chatId, text=msg)
        elif step.startswith("note:"):
            _, topic, note = step.split(":", 2)
            await self._note(int(topic), note)

    async def _from_user(self, u: TelegramUpdate) -> list[str]:
        topic, new = await self._topic(u.fromId)
        if u.command == "start":
            if u.userId and await self._link(u.fromId, u.userId):
                orgs = await self.pool.fetch(
                    "select organization_id from member where user_id = $1 limit 5", u.userId
                )
                ids = ", ".join(r["organization_id"] for r in orgs) or "none"
                note = f"note:{topic}:Linked to app user {u.userId} (organizations: {ids})."
                return ["linked", note]
            return ["link-failed"] if u.linkFailed else ["ack"]
        try:
            await self._copy(u, topic)
        except BotError as e:
            if "thread not found" not in e.description:
                raise
            topic, new = await self._topic(u.fromId, stale=topic)  # the team deleted the topic
            await self._copy(u, topic)
        return ["react", "ack"] if new else ["react"]

    async def _from_team(self, u: TelegramUpdate) -> list[str]:
        row = await self.pool.fetchrow(
            "select telegram_user_id, user_id from telegram_support_users"
            " where chat_id = $1 and topic_id = $2",
            self.chat_id,
            u.threadId,
        )
        if row is None:
            return []
        if u.command in ("bug", "feature"):
            return await self._file(u, row["user_id"])
        if u.command:
            return []  # other commands stay in the team's group
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
            return [f"note:{u.threadId}:Not delivered ({e.description or e.status})."]
        return []

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

    async def _link(self, tg_user: int, user_id: str) -> bool:
        try:
            done = await self.pool.execute(
                "update telegram_support_users set user_id = $2 where telegram_user_id = $1",
                tg_user,
                user_id,
            )
        except asyncpg.ForeignKeyViolationError:
            return False  # the account was deleted since the link was made
        return done.endswith(" 1")

    async def _file(self, u: TelegramUpdate, user_id: str | None) -> list[str]:
        """`/bug <title>` or `/feature <title>` (title redacted by the API, in S3): a "+1" on
        the open item with that title, or a new item (config/tracker.json producers)."""
        try:
            doc = obj(json.loads(await self.files.get(u.s3Key))) if u.s3Key else {}
        except NotFound:
            return []  # a retry after the item was filed and the object deleted
        title = str(doc.get("title", "")).strip()[:120]
        if not title:
            return [f"note:{u.threadId}:Usage: /{u.command} <short title>"]
        category = "bug" if u.command == "bug" else "feature_request"
        link = topic_link(self.chat_id, u.threadId)
        if existing := await find_open(self.tracker, title):
            status = await self.tracker.read(existing.ref)
            # Already linked to this topic (a retry, or the same user again): no second "+1".
            if not status or not any(link in t for t in status.texts):
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
        await self.files.delete(u.s3Key)
        return [f"note:{u.threadId}:{verb}: {item.url or f'(dry run, {self.tracker.name})'}"]

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

    async def _in_topic(self, method: str, topic: int, **params: Any) -> None:
        """A call into a topic; a topic the team closed is reopened first."""
        try:
            await self.bot(method, chat_id=self.chat_id, message_thread_id=topic, **params)
        except BotError as e:
            if "TOPIC_CLOSED" not in e.description:
                raise
            await self.bot("reopenForumTopic", chat_id=self.chat_id, message_thread_id=topic)
            await self.bot(method, chat_id=self.chat_id, message_thread_id=topic, **params)

    async def _copy(self, u: TelegramUpdate, topic: int) -> None:
        await self._in_topic("copyMessage", topic, from_chat_id=u.chatId, message_id=u.messageId)

    async def _note(self, topic: int, text: str) -> None:
        await self._in_topic("sendMessage", topic, text=text)
