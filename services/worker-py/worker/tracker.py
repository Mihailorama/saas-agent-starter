"""The one tracker every producer files into (docs/support.md "Trackers").

PostHog alerts and survey feedback (TrackerItemWorkflow, started by apps/api/src/routes/hooks.ts),
the support triage (worker/support.py) and the release comments (worker/released.py) all go
through `connect()`: Plane by default, through Plane's official SDK (`plane-sdk`), new items in the
project's Intake unless config/tracker.json names a state for the producer; GitHub Issues as an
optional alternative (TRACKER=github). Nothing here closes an item or moves it to a completed or
cancelled state: a producer configured with such a state stops the worker at start.

Errors carry only a status or an error class: request URLs hold search terms, which must not reach
logs, Temporal history or Sentry.
"""

import asyncio
import json
import logging
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, cast
from urllib.parse import quote

import httpx2
import pydantic
import requests
from plane import PlaneClient
from plane.errors import HttpError
from plane.models.intake import CreateIntakeWorkItem
from plane.models.labels import CreateLabel
from plane.models.query_params import PaginatedQueryParams, RetrieveQueryParams
from plane.models.work_items import (
    CreateWorkItem,
    CreateWorkItemComment,
    UpdateWorkItem,
    WorkItemForIntakeRequest,
)
from temporalio import activity

from worker import settings
from worker.s3 import S3, NotFound

log = logging.getLogger(__name__)

Group = Literal["open", "completed", "cancelled"]
FINISHED = ("completed", "cancelled")
# A PR closes an item only with a closing keyword (GitHub's list): `Fixes PROJ-123`, `Closes #12`.
CLOSES = r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+"
INBOX = "tracker-inbox/"  # S3 prefix of items waiting for TrackerItemWorkflow (uploads bucket)


class TrackerError(Exception):
    """A tracker call failed; `status` is the HTTP status when there was a response."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Item:
    ref: str
    url: str
    title: str = ""


@dataclass(frozen=True)
class Status:
    url: str
    group: Group  # completed = done; cancelled = closed without a fix (not planned, declined)
    texts: list[str]  # body + comments: where the conversation links are


def obj(value: object) -> dict[str, Any]:
    """A JSON object from an API response, or {} for anything else."""
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def producers() -> dict[str, dict[str, Any]]:
    """config/tracker.json: per producer its `labels` and, for Plane, an optional target `state`."""
    raw = obj(json.loads(settings.TRACKER_FILE.read_text())["producers"])
    return {k: obj(v) for k, v in raw.items()}


def producer_config(name: str) -> dict[str, Any]:
    found = producers()
    if name not in found:
        raise KeyError(f"tracker producer {name!r} is not in config/tracker.json")
    return found[name]


class Tracker(Protocol):
    name: str

    async def search(self, query: str) -> list[Item]:
        """Open items matching `query` (Plane: Intake items waiting for a human included)."""
        ...

    async def create(self, producer: str, title: str, body: str) -> Item: ...
    async def comment(self, ref: str, body: str) -> None: ...
    async def read(self, ref: str) -> Status | None: ...

    async def closed_by(self, text: str) -> list[str]:
        """Refs of items a PR title/body closes with a closing keyword (not bare mentions)."""
        ...

    async def is_own(self, author: str) -> bool:
        """Whether `author` (a comment's author id) is this integration's own user."""
        ...


async def find_open(tracker: Tracker, title: str) -> Item | None:
    """An open item with exactly this title (Plane: Intake included)."""
    return next((i for i in await tracker.search(title) if i.title == title), None)


def _html(text: str) -> str:
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "".join(f"<p>{line}</p>" for line in escaped.split("\n") if line)


class _SearchParams(RetrieveQueryParams):
    # The search endpoint is workspace-wide; these narrow it (the SDK's params class lacks them).
    project_id: str
    limit: int = 20


class Plane:
    """Plane REST API v1 through the official SDK (synchronous: each call runs in a thread)."""

    name = "plane"
    WAITING = (-2, 0)  # Intake statuses still waiting for a human: pending, snoozed

    def __init__(self, client: PlaneClient, *, app_url: str, workspace: str, project_id: str):
        self.c, self.ws, self.pid = client, workspace, project_id
        self.app = f"{app_url.rstrip('/')}/{workspace}/projects/{project_id}/issues"
        self.states: dict[str, str] = {}  # producer -> state id (config/tracker.json `state`)
        self._me: str | None = None
        self._identifier: str | None = None

    @classmethod
    async def connect(
        cls, *, api_url: str, app_url: str, workspace: str, project_id: str, token: str
    ) -> "Plane":
        """Resolves each producer's target state once and refuses completed/cancelled ones."""
        self = cls(
            PlaneClient(base_url=api_url, api_key=token),
            app_url=app_url,
            workspace=workspace,
            project_id=project_id,
        )
        wanted = {n: str(p["state"]) for n, p in producers().items() if p.get("state")}
        if wanted:
            states = await self._all(lambda q: self.c.states.list(self.ws, self.pid, q))
            for producer, state in wanted.items():
                found = [s for s in states if s.name == state]
                if not found or not found[0].id:
                    raise ValueError(f"config/tracker.json: Plane state {state!r} not found")
                if found[0].group in FINISHED:
                    raise ValueError(
                        f"config/tracker.json: producer {producer!r} targets Plane state"
                        f" {state!r} (group {found[0].group}); automation never files items into"
                        " a completed or cancelled state. Pick an open state or drop `state`."
                    )
                self.states[producer] = found[0].id
        return self

    def _url(self, ref: str) -> str:
        return f"{self.app}/{ref}"

    async def _call[T](self, fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except HttpError as e:
            raise TrackerError(f"Plane API: HTTP {e.status_code}", e.status_code) from None
        except (requests.RequestException, pydantic.ValidationError) as e:
            raise TrackerError(f"Plane API: {type(e).__name__}") from None

    async def _all(self, list_page: Callable[[dict[str, Any]], Any]) -> list[Any]:
        """Every page of a cursor-paginated list."""
        out: list[Any] = []
        query: dict[str, Any] = {"per_page": 100}
        while True:
            page = await self._call(list_page, query)
            out += page.results
            if not page.next_page_results or not page.next_cursor:
                return out
            query = {"per_page": 100, "cursor": page.next_cursor}

    async def _read(self, ref: str) -> Any:
        """The work item with its state, or None (404: another project's item, or in Intake)."""
        expand = RetrieveQueryParams.model_validate({"expand": "state"})
        try:
            return await self._call(self.c.work_items.retrieve, self.ws, self.pid, ref, expand)
        except TrackerError as e:
            if e.status == 404:
                return None
            raise

    @staticmethod
    def _group(item: Any) -> Group:
        group = getattr(item.state, "group", None)
        return group if group in FINISHED else "open"

    async def search(self, query: str) -> list[Item]:
        q = query.lower()
        intake = await self._all(
            lambda p: self.c.intake.list(self.ws, self.pid, PaginatedQueryParams(**p))
        )
        items: list[Item] = []
        for (
            i
        ) in intake:  # search skips items still in Intake (triage state), so they come from here
            name = str(i.issue_detail.name or "") if i.issue_detail else ""
            if i.status in self.WAITING and i.issue and q in name.lower():
                items.append(Item(i.issue, self._url(i.issue), name))
        params = _SearchParams.model_validate({"project_id": self.pid})
        found = await self._call(self.c.work_items.search, self.ws, query, params)
        for hit in found.issues:  # search has no state filter: drop finished ones
            if hit.project_id != self.pid:
                continue
            item = await self._read(hit.id)
            if item is not None and self._group(item) == "open":
                items.append(Item(hit.id, self._url(hit.id), hit.name))
        return items

    async def _label_ids(self, names: list[str]) -> list[str]:
        if not names:
            return []
        have = {
            str(x.name): str(x.id)
            for x in await self._all(lambda q: self.c.labels.list(self.ws, self.pid, q))
        }
        for n in names:
            if n not in have:
                made = await self._call(
                    self.c.labels.create, self.ws, self.pid, CreateLabel(name=n)
                )
                have[n] = str(made.id)
        return [have[n] for n in names]

    async def create(self, producer: str, title: str, body: str) -> Item:
        labels = await self._label_ids(
            [str(x) for x in producer_config(producer).get("labels", [])]
        )
        html = _html(body)
        if state := self.states.get(producer):
            new = CreateWorkItem(name=title, description_html=html, state=state, labels=labels)
            ref = str((await self._call(self.c.work_items.create, self.ws, self.pid, new)).id)
        else:
            new = CreateIntakeWorkItem(
                issue=WorkItemForIntakeRequest(name=title, description_html=html)
            )
            ref = str((await self._call(self.c.intake.create, self.ws, self.pid, new)).issue)
            if labels:  # Intake takes no labels on create; the work item behind it does
                patch = UpdateWorkItem(labels=labels)
                await self._call(self.c.work_items.update, self.ws, self.pid, ref, patch)
        return Item(ref, self._url(ref), title)

    async def comment(self, ref: str, body: str) -> None:
        new = CreateWorkItemComment(comment_html=_html(body))
        await self._call(self.c.work_items.comments.create, self.ws, self.pid, ref, new)

    async def read(self, ref: str) -> Status | None:
        item = await self._read(ref)
        if item is None:
            return None
        comments = await self._all(
            lambda q: self.c.work_items.comments.list(self.ws, self.pid, ref, q)
        )
        texts = [str(item.description_html or ""), *(str(c.comment_html or "") for c in comments)]
        return Status(self._url(ref), self._group(item), texts)

    async def closed_by(self, text: str) -> list[str]:
        if self._identifier is None:
            project = await self._call(self.c.projects.retrieve, self.ws, self.pid)
            self._identifier = project.identifier
        ident = self._identifier
        refs: list[str] = []
        for seq in re.findall(rf"{CLOSES}{re.escape(ident)}-(\d+)\b", text, re.IGNORECASE):
            try:
                found = await self._call(
                    self.c.work_items.retrieve_by_identifier, self.ws, ident, int(seq)
                )
            except TrackerError as e:
                if e.status == 404:  # a typo in a PR
                    continue
                raise
            if found.id and found.id not in refs:
                refs.append(found.id)
        return refs

    async def is_own(self, author: str) -> bool:
        if self._me is None:
            self._me = str((await self._call(self.c.users.get_me)).id)
        return bool(author) and author == self._me


class GitHub:
    """Optional alternative (TRACKER=github), and the pull request reader of worker/released.py.

    Plain REST over httpx2: githubkit (MIT) would add a second HTTP client stack for six calls.
    """

    name = "github"

    def __init__(self, repo: str, token: str, http: httpx2.AsyncClient, api_url: str = "") -> None:
        self.repo, self.http = repo, http
        self.api = (api_url or "https://api.github.com").rstrip("/")  # GITHUB_API_URL: GHES
        self.headers = {
            "authorization": f"Bearer {token}",
            "accept": "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
        }

    async def _call(self, method: str, path: str, body: object = None) -> Any:
        try:
            res = await self.http.request(
                method, f"{self.api}{path}", headers=self.headers, json=body
            )
        except httpx2.HTTPError as e:
            raise TrackerError(f"GitHub API: {type(e).__name__}") from None
        if res.is_error:
            raise TrackerError(f"GitHub API: HTTP {res.status_code}", res.status_code)
        return res.json()

    async def search(self, query: str) -> list[Item]:
        q = quote(f"repo:{self.repo} is:issue is:open {query}")
        found = await self._call("GET", f"/search/issues?per_page=20&q={q}")
        return [Item(str(i["number"]), i["html_url"], i["title"]) for i in found["items"]]

    async def create(self, producer: str, title: str, body: str) -> Item:
        labels = list(producer_config(producer).get("labels", []))
        i = await self._call(
            "POST", f"/repos/{self.repo}/issues", {"title": title, "body": body, "labels": labels}
        )
        return Item(str(i["number"]), i["html_url"], title)

    async def comment(self, ref: str, body: str) -> None:
        await self._call("POST", f"/repos/{self.repo}/issues/{ref}/comments", {"body": body})

    async def label(self, ref: str, name: str) -> None:
        await self._call("POST", f"/repos/{self.repo}/issues/{ref}/labels", {"labels": [name]})

    async def read(self, ref: str) -> Status | None:
        i = await self._call("GET", f"/repos/{self.repo}/issues/{ref}")
        comments = await self._call("GET", f"/repos/{self.repo}/issues/{ref}/comments?per_page=100")
        texts = [str(i.get("body") or ""), *(str(c.get("body") or "") for c in comments)]
        group: Group = (
            "open"
            if i["state"] != "closed"
            else "completed"
            if i.get("state_reason") == "completed"
            else "cancelled"
        )
        return Status(i["html_url"], group, texts)

    async def closed_by(self, text: str) -> list[str]:
        return list(dict.fromkeys(re.findall(rf"{CLOSES}#(\d+)\b", text, re.IGNORECASE)))

    async def is_own(self, author: str) -> bool:
        return True  # the GitHub return path reacts only to issues labelled `support`

    async def merged_prs(self, sha: str) -> list[dict[str, Any]]:
        """Merged pull requests that contain the commit."""
        prs = await self._call("GET", f"/repos/{self.repo}/commits/{sha}/pulls")
        return [obj(p) for p in prs if obj(p).get("merged_at")]


class DryRunTracker:
    """No tracker credentials: nothing is created, the logs say what would have happened."""

    name = "dry-run"

    async def search(self, query: str) -> list[Item]:
        return []

    async def create(self, producer: str, title: str, body: str) -> Item:
        log.info("dry run: would create a %s tracker item", producer)
        return Item("dry-run", "", title)

    async def comment(self, ref: str, body: str) -> None:
        log.info("dry run: would comment on tracker item %s", ref)

    async def read(self, ref: str) -> Status | None:
        return None

    async def closed_by(self, text: str) -> list[str]:
        return []

    async def is_own(self, author: str) -> bool:
        return False


async def connect(http: httpx2.AsyncClient) -> Tracker:
    """TRACKER selects the adapter (plane by default); missing credentials = dry run."""
    s = settings
    if s.TRACKER == "plane":
        if s.PLANE_API_URL and s.PLANE_WORKSPACE and s.PLANE_PROJECT_ID and s.PLANE_API_TOKEN:
            return await Plane.connect(
                api_url=s.PLANE_API_URL,
                app_url=s.PLANE_APP_URL,
                workspace=s.PLANE_WORKSPACE,
                project_id=s.PLANE_PROJECT_ID,
                token=s.PLANE_API_TOKEN,
            )
    elif s.TRACKER == "github":
        if s.GITHUB_TOKEN and s.GITHUB_REPO:
            return GitHub(s.GITHUB_REPO, s.GITHUB_TOKEN, http, s.GITHUB_API_URL)
    else:
        raise ValueError(f"TRACKER must be plane or github, not {s.TRACKER!r}")
    return DryRunTracker()


@dataclass(frozen=True)
class TrackerItem:
    """Workflow input. Contract with apps/api/src/temporal.ts: the text is in S3, not here."""

    producer: str
    s3Key: str


class TrackerActivities:
    def __init__(self, tracker: Tracker, files: S3) -> None:
        self.tracker, self.files = tracker, files

    @activity.defn(name="file_tracker_item")
    async def file_item(self, item: TrackerItem) -> str:
        """Comments on the open item with the same title or files a new one, then deletes the
        S3 object (leftovers: PrivacyActivities.purge_tracker_inbox).
        ponytail: a crash between filing and the delete repeats the text as a comment on retry."""
        if not item.s3Key.startswith(INBOX):
            raise ValueError("tracker item key outside the inbox prefix")
        try:
            doc = obj(json.loads(await self.files.get(item.s3Key)))
        except NotFound:
            return "gone"  # a retry after the delete: already filed
        title, body = str(doc["title"]), str(doc["body"])
        if existing := await find_open(self.tracker, title):
            await self.tracker.comment(existing.ref, body)
            action = "commented"
        else:
            await self.tracker.create(item.producer, title, body)
            action = "created"
        await self.files.delete(item.s3Key)
        log.info("tracker item (%s): %s in %s", item.producer, action, self.tracker.name)
        return action


async def smoke(tag: str) -> None:
    """One alert, one support item and one release comment against the configured project
    (docs/support.md "Live smoke run"). Files into Intake; closes and moves nothing."""
    async with httpx2.AsyncClient(timeout=30) as http:
        tracker = await connect(http)
        if isinstance(tracker, DryRunTracker):
            raise SystemExit("no tracker credentials (PLANE_* or TRACKER=github + GITHUB_*)")
        stamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
        alert = "[cjm] smoke test: signup funnel"
        body = f"Smoke test alert at {stamp} (docs/support.md). Safe to decline."
        if existing := await find_open(tracker, alert):
            await tracker.comment(existing.ref, body)
            print(f"alert: commented on {existing.url}")
        else:
            print(f"alert: created {(await tracker.create('cjm-regression', alert, body)).url}")
        item = await tracker.create(
            "support-bug", f"Smoke test: support item {stamp}", "Filed by the smoke test."
        )
        print(f"triage item: created {item.url}")
        await tracker.comment(item.ref, f"Released in {tag} (smoke test, no PR).")
        status = await tracker.read(item.ref)
        print(f"release comment: posted; item group now {status.group if status else 'Intake'}")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "smoke":
        raise SystemExit("usage: python -m worker.tracker smoke <tag, e.g. v0.0.0-smoke>")
    asyncio.run(smoke(sys.argv[2]))
