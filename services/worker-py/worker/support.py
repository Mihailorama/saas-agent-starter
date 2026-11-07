"""Service desk triage (docs/support.md, docs/adr/0013-service-desk-chatwoot.md).

Tickets live in Chatwoot, backlog items in the tracker (GitHub Issues or Plane Intake). We store
neither: the conversation <-> issue link is the conversation URL written into the issue (body or
"+1" comment) plus the `tracker_issue_url` custom attribute on the conversation. The bot only
writes private notes; it never answers a customer on its own (except the opt-in "resolved"
message, SUPPORT_NOTIFY_ON_CLOSE=true|release).
"""

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Protocol, cast
from urllib.parse import quote

import httpx2
from temporalio import activity

from worker import prompts
from worker.activities import ModelChoice
from worker.ai import Gateway, Message

log = logging.getLogger(__name__)

PURPOSE = "support.triage"
# prompts/support.triage/*.v1.md. New prompt text = new file + bump the version here.
TRIAGE_PROMPT = ("support.triage/system", 1)
DUPLICATE_PROMPT = ("support.triage/duplicate", 1)
CATEGORIES = ("question", "bug", "feature_request", "billing", "spam")
FILED = ("bug", "feature_request")
LABELS = {"bug": "bug", "feature_request": "feature-request"}
# The conversation URL is the link: it survives tracker HTML sanitizers and humans can click it.
CONVERSATION_URL = re.compile(r"/app/accounts/(\d+)/conversations/(\d+)")
# Widget context (apps/web/src/lib/support.ts) that is copied into the issue.
CONTEXT_KEYS = ("request_kind", "org_id", "page", "replay_url", "trace_id")
RESOLVED_MESSAGE = (
    "Good news: the problem you reported has been resolved. Thank you for letting us know!"
)
EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+")


@dataclass(frozen=True)
class SupportConversation:
    """Workflow input. Contract with apps/api/src/temporal.ts (ids only, no content)."""

    accountId: int
    conversationId: int


@dataclass(frozen=True)
class SupportIssueClosed:
    """Workflow input. Contract with apps/api/src/temporal.ts."""

    tracker: str  # github | plane
    issueId: str
    release: str = ""  # tag from the "Released in vX.Y.Z" comment (GitHub), "" for a close


@dataclass(frozen=True)
class Item:
    ref: str
    url: str
    title: str = ""


@dataclass(frozen=True)
class Closed:
    url: str
    resolved: bool  # done, as opposed to "not planned" / cancelled
    texts: list[str]  # body + comments: where the conversation links are


@dataclass(frozen=True)
class Triage:
    category: str
    title: str
    summary: str
    search: str
    answer: str


def obj(value: object) -> dict[str, Any]:
    """A JSON object from an API response, or {} for anything else."""
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def triage_input(kind_hint: str, transcript: str) -> str:
    """The user message; evals/support.triage stores exactly this as `input`."""
    return f"Kind picked in the widget: {kind_hint}\n\nConversation:\n{transcript}"


def scrub(value: object, limit: int = 300) -> str:
    return EMAIL.sub("[email]", str(value))[:limit]


def parse_triage(text: str) -> Triage | None:
    """The model's JSON answer, or None if it is not usable."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    try:
        get = obj(json.loads(match.group(0)) if match else None)
    except json.JSONDecodeError:
        return None
    if get.get("category") not in CATEGORIES:
        return None
    return Triage(
        category=str(get["category"]),
        title=scrub(get.get("title", ""), 120).strip() or "Support request",
        summary=scrub(get.get("summary", ""), 2000).strip(),
        search=scrub(get.get("search", ""), 200).strip(),
        answer=str(get.get("answer", "")).strip(),
    )


def linked_conversations(texts: list[str]) -> list[SupportConversation]:
    found = {(int(a), int(c)) for t in texts for a, c in CONVERSATION_URL.findall(t)}
    return [SupportConversation(a, c) for a, c in sorted(found)]


class Chatwoot:
    """The few Chatwoot application API calls we need (header `api_access_token`)."""

    def __init__(self, url: str, token: str, public_url: str, http: httpx2.AsyncClient) -> None:
        self.url, self.public_url, self.http = url.rstrip("/"), public_url.rstrip("/"), http
        self.headers = {"api_access_token": token}

    def link(self, c: SupportConversation) -> str:
        return f"{self.public_url}/app/accounts/{c.accountId}/conversations/{c.conversationId}"

    async def _call(self, method: str, c: SupportConversation, path: str = "", **body: Any) -> Any:
        url = f"{self.url}/api/v1/accounts/{c.accountId}/conversations/{c.conversationId}{path}"
        res = await self.http.request(method, url, headers=self.headers, json=body or None)
        res.raise_for_status()
        return res.json()

    async def conversation(self, c: SupportConversation) -> dict[str, Any]:
        return await self._call("GET", c)

    async def customer_messages(self, c: SupportConversation) -> list[str]:
        payload: list[dict[str, Any]] = (await self._call("GET", c, "/messages"))["payload"]
        # message_type 0 = incoming (from the customer); private notes are never customer text.
        return [
            str(m["content"])
            for m in payload
            if m.get("message_type") == 0 and not m.get("private") and m.get("content")
        ]

    async def set_attributes(self, c: SupportConversation, attrs: dict[str, str]) -> None:
        await self._call("POST", c, "/custom_attributes", custom_attributes=attrs, merge=True)

    async def note(self, c: SupportConversation, text: str) -> None:
        await self._call(
            "POST", c, "/messages", content=text, message_type="outgoing", private=True
        )

    async def reply(self, c: SupportConversation, text: str) -> None:
        await self._call("POST", c, "/messages", content=text, message_type="outgoing")


class Tracker(Protocol):
    name: str

    async def search(self, query: str) -> list[Item]: ...
    async def create(self, title: str, body: str, kind: str) -> Item: ...
    async def comment(self, ref: str, body: str) -> None: ...
    async def closed(self, ref: str) -> Closed | None: ...


class GitHubIssues:
    """Same headers and labels as the PostHog hook in apps/api/src/routes/hooks.ts."""

    name = "github"

    def __init__(self, repo: str, token: str, http: httpx2.AsyncClient) -> None:
        self.repo, self.http = repo, http
        self.headers = {
            "authorization": f"Bearer {token}",
            "accept": "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
        }

    async def _call(self, method: str, path: str, body: object = None) -> Any:
        res = await self.http.request(
            method, f"https://api.github.com{path}", headers=self.headers, json=body
        )
        res.raise_for_status()
        return res.json()

    async def search(self, query: str) -> list[Item]:
        q = quote(f"repo:{self.repo} is:issue is:open {query}")
        found = await self._call("GET", f"/search/issues?per_page=5&q={q}")
        return [Item(str(i["number"]), i["html_url"], i["title"]) for i in found["items"]]

    async def create(self, title: str, body: str, kind: str) -> Item:
        labels = ["from-users", "support", LABELS[kind]]
        i = await self._call(
            "POST", f"/repos/{self.repo}/issues", {"title": title, "body": body, "labels": labels}
        )
        return Item(str(i["number"]), i["html_url"], title)

    async def comment(self, ref: str, body: str) -> None:
        await self._call("POST", f"/repos/{self.repo}/issues/{ref}/comments", {"body": body})
        # The API's return-path hook only reacts to issues with this label.
        await self._call("POST", f"/repos/{self.repo}/issues/{ref}/labels", {"labels": ["support"]})

    async def closed(self, ref: str) -> Closed | None:
        i = await self._call("GET", f"/repos/{self.repo}/issues/{ref}")
        if i["state"] != "closed":
            return None
        comments = await self._call("GET", f"/repos/{self.repo}/issues/{ref}/comments?per_page=100")
        texts = [str(i.get("body") or ""), *(str(c.get("body") or "") for c in comments)]
        return Closed(i["html_url"], i.get("state_reason") == "completed", texts)


class PlaneIntake:
    """Plane REST API v1 (header X-API-Key): new items go to the project's Intake for triage."""

    name = "plane"

    def __init__(
        self,
        *,
        api_url: str,
        app_url: str,
        workspace: str,
        project_id: str,
        token: str,
        http: httpx2.AsyncClient,
    ) -> None:
        self.base = f"{api_url.rstrip('/')}/api/v1/workspaces/{workspace}"
        self.project = f"{self.base}/projects/{project_id}"
        self.app = f"{app_url.rstrip('/')}/{workspace}/projects/{project_id}/issues"
        self.http, self.headers = http, {"x-api-key": token}

    async def _call(self, method: str, url: str, body: object = None) -> Any:
        res = await self.http.request(method, url, headers=self.headers, json=body)
        res.raise_for_status()
        return res.json()

    async def _item(self, ref: str) -> dict[str, Any]:
        return await self._call("GET", f"{self.project}/work-items/{ref}/?expand=state")

    async def search(self, query: str) -> list[Item]:
        project_id = self.project.rsplit("/", 1)[1]
        found = await self._call(
            "GET",
            f"{self.base}/work-items/search/?limit=5&project_id={project_id}&search={quote(query)}",
        )
        items: list[Item] = []
        for i in found["issues"]:  # search has no state filter: drop finished ones
            state = obj((await self._item(i["id"])).get("state"))
            if state.get("group") not in ("completed", "cancelled"):
                items.append(Item(i["id"], f"{self.app}/{i['id']}", i["name"]))
        return items

    async def create(self, title: str, body: str, kind: str) -> Item:
        html = "".join(f"<p>{line}</p>" for line in _html_escape(body).split("\n") if line)
        res = await self._call(
            "POST",
            f"{self.project}/intake-issues/",
            {"issue": {"name": title, "description_html": html}},
        )
        issue: object = res["issue"]  # the docs show an object; older servers return the id
        ref = str(obj(issue).get("id") or issue)
        return Item(ref, f"{self.app}/{ref}", title)

    async def comment(self, ref: str, body: str) -> None:
        html = "".join(f"<p>{line}</p>" for line in _html_escape(body).split("\n") if line)
        await self._call(
            "POST", f"{self.project}/work-items/{ref}/comments/", {"comment_html": html}
        )

    async def closed(self, ref: str) -> Closed | None:
        i = await self._item(ref)
        group = obj(i.get("state")).get("group")
        if group not in ("completed", "cancelled"):
            return None
        comments = await self._call("GET", f"{self.project}/work-items/{ref}/comments/")
        texts = [str(i.get("description_html") or "")]
        texts += [str(c.get("comment_html") or "") for c in comments.get("results", [])]
        return Closed(f"{self.app}/{ref}", group == "completed", texts)


def _html_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class DryRunTracker:
    """No tracker credentials: nothing is created, the note says what would have happened."""

    name = "dry-run"

    async def search(self, query: str) -> list[Item]:
        return []

    async def create(self, title: str, body: str, kind: str) -> Item:
        log.info("dry run: would create a %s tracker item", kind)
        return Item("dry-run", "", title)

    async def comment(self, ref: str, body: str) -> None:
        log.info("dry run: would comment on tracker item %s", ref)

    async def closed(self, ref: str) -> Closed | None:
        return None


class SupportActivities:
    def __init__(
        self,
        *,
        chatwoot: Chatwoot | None,
        tracker: Tracker,
        ai: Gateway | None,
        model: ModelChoice | None,
        ai_org_id: str,
        notify: str = "",
    ) -> None:
        self.chatwoot, self.tracker = chatwoot, tracker
        self.ai, self.model, self.ai_org_id = ai, model, ai_org_id
        self.notify = notify  # "" | "close" | "release": when the customer hears it is resolved

    async def _llm(self, c: SupportConversation, prompt_ref: tuple[str, int], user: str) -> str:
        assert self.ai is not None and self.model is not None
        prompt = prompts.load(*prompt_ref)
        result = await self.ai.call_llm(
            PURPOSE,
            [Message("system", prompt.text), Message("user", user)],
            model=self.model.model,
            provider=self.model.provider,
            org_id=self.ai_org_id,
            actor_id=f"chatwoot:{c.accountId}/{c.conversationId}",
            prompt_template_id=prompt.id,
            prompt_template_version=prompt.version,
            max_tokens=1500,
        )
        return result.text

    @activity.defn(name="support_triage")
    async def triage(self, c: SupportConversation) -> str:
        """Classifies the conversation, files or +1s a tracker item, writes one private note.

        Safe to retry: a finished triage leaves `support_category` on the conversation, and a
        created item is recorded in `tracker_issue_url` at once, so a retry does not file it again.
        ponytail: a crash between the note and the final attribute write repeats the note once.
        """
        cw = self.chatwoot
        if cw is None:
            log.info("dry run: CHATWOOT_URL/CHATWOOT_API_TOKEN unset, conversation %s", c)
            return "dry-run"
        if self.ai is None or self.model is None or not self.ai_org_id:
            log.info("support triage off (no model or SUPPORT_AI_ORG_ID), conversation %s", c)
            return "off"
        conv = await cw.conversation(c)
        attrs = obj(conv.get("custom_attributes"))
        if attrs.get("support_category"):
            return str(attrs["support_category"])
        sender = obj(obj(conv.get("meta")).get("sender"))
        context = {**obj(sender.get("custom_attributes")), **attrs}  # conversation wins

        transcript = "\n\n".join(await cw.customer_messages(c))[:20_000]
        hint = scrub(context.get("request_kind") or "none", 40)
        text = await self._llm(c, TRIAGE_PROMPT, triage_input(hint, transcript))
        t = parse_triage(text)
        if t is None:
            await cw.note(c, "AI triage could not classify this conversation. Please triage it.")
            await cw.set_attributes(c, {"support_category": "unclassified"})
            return "unclassified"

        lines = [f"AI triage: **{t.category}** ({self.model.provider}/{self.model.model})"]
        if t.summary:
            lines.append(t.summary)
        done: dict[str, str] = {"support_category": t.category}
        if t.category in FILED:
            url = str(attrs.get("tracker_issue_url") or "")
            if not url:
                item, duplicate = await self._file(c, t, context)
                url = item.url
                if url:
                    await cw.set_attributes(c, {"tracker_issue_url": url})
                verb = "Added as +1 to the existing issue" if duplicate else "Filed"
                lines.append(f"{verb}: {url or f'(dry run, {self.tracker.name}) {t.title}'}")
            else:
                lines.append(f"Linked issue: {url}")
            if url:
                done["tracker_issue_url"] = url
        elif t.category == "question" and t.answer:
            lines.append(f"Draft answer (review before sending, not sent):\n\n{t.answer}")
        elif t.category == "billing":
            lines.append("Billing request: needs a human with access to the billing system.")
        elif t.category == "spam":
            lines.append("Looks like spam. Resolve the conversation if you agree.")
        await cw.note(c, "\n\n".join(lines))
        await cw.set_attributes(c, done)
        activity.logger.info("triaged conversation %s as %s", c, t.category)
        return t.category

    async def _file(
        self, c: SupportConversation, t: Triage, context: dict[str, Any]
    ) -> tuple[Item, bool]:
        """A "+1" comment on an open duplicate, or a new tracker item."""
        assert self.chatwoot is not None
        link = self.chatwoot.link(c)
        candidates = await self.tracker.search(t.search) if t.search else []
        if candidates:
            listing = "\n".join(f"{n}. {i.title}" for n, i in enumerate(candidates, 1))
            answer = await self._llm(
                c,
                DUPLICATE_PROMPT,
                f"New request:\nTitle: {t.title}\nSummary: {t.summary}\n\nOpen issues:\n{listing}",
            )
            pick = re.search(r"\d+", answer)
            n = int(pick.group(0)) if pick else 0
            if 1 <= n <= len(candidates):
                dup = candidates[n - 1]
                await self.tracker.comment(
                    dup.ref, f"+1 user: {t.summary}\n\nSupport conversation: {link}"
                )
                return dup, True
        details = [f"- {k}: {scrub(context[k])}" for k in CONTEXT_KEYS if context.get(k)]
        body = "\n".join(
            [
                t.summary,
                "",
                f"- Category: {t.category}",
                f"- Support conversation: {link}",
                *details,
                "",
                "---",
                "For the agent: filed by the support triage (docs/support.md). The conversation",
                "link is how the reporter is told when this closes; keep it in the issue.",
            ]
        )
        return await self.tracker.create(t.title, body, t.category), False

    @activity.defn(name="support_issue_closed")
    async def issue_closed(self, e: SupportIssueClosed) -> int:
        """Writes a private note into every conversation linked from the closed item."""
        if e.tracker != self.tracker.name:
            log.info("ignored %s close event: tracker here is %s", e.tracker, self.tracker.name)
            return 0
        closed = await self.tracker.closed(e.issueId)
        if closed is None:  # reopened since, or not finished
            return 0
        conversations = linked_conversations(closed.texts)
        if self.chatwoot is None:
            log.info("dry run: would notify %d conversations", len(conversations))
            return len(conversations)
        if e.release:
            note = f"Linked issue {closed.url} is live in {e.release}."
        elif closed.resolved:
            note = f"Linked issue {closed.url} was resolved."
        else:
            note = f"Linked issue {closed.url} was closed without a fix (not planned)."
        tell = closed.resolved and self.notify == ("release" if e.release else "close")
        for c in conversations:
            await self.chatwoot.note(c, note)
            if tell:
                await self.chatwoot.reply(c, RESOLVED_MESSAGE)
        activity.logger.info("issue %s closed: notified %d conversations", e, len(conversations))
        return len(conversations)
