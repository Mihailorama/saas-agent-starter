"""The tracker the support triage files into: Python twin of apps/api/src/tracker.ts.

Same contract, same config (TRACKER, PLANE_*/GITHUB_*, config/tracker.json producers): Plane by
default, new items in the project's Intake unless the producer names a state; GitHub Issues as an
optional alternative. Nothing here closes an item or moves it to a completed state.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast
from urllib.parse import quote

import httpx2

from worker import settings

log = logging.getLogger(__name__)

Group = Literal["open", "completed", "cancelled"]


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


def producer_config(name: str) -> dict[str, Any]:
    """config/tracker.json: `labels` and, for Plane, an optional target `state`."""
    producers = obj(json.loads(settings.TRACKER_FILE.read_text())["producers"])
    if name not in producers:
        raise KeyError(f"tracker producer {name!r} is not in config/tracker.json")
    return obj(producers[name])


class Tracker(Protocol):
    name: str

    async def search(self, query: str) -> list[Item]: ...
    async def create(self, producer: str, title: str, body: str) -> Item: ...
    async def comment(self, ref: str, body: str) -> None: ...
    async def read(self, ref: str) -> Status | None: ...


def _html(text: str) -> str:
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "".join(f"<p>{line}</p>" for line in escaped.split("\n") if line)


class Plane:
    """Plane REST API v1 (header X-API-Key)."""

    name = "plane"
    WAITING = (-2, 0)  # Intake statuses still waiting for a human: pending, snoozed

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
        self.project_id = project_id
        self.project = f"{self.base}/projects/{project_id}"
        self.app = f"{app_url.rstrip('/')}/{workspace}/projects/{project_id}/issues"
        self.http, self.headers = http, {"x-api-key": token}

    async def _call(self, method: str, url: str, body: object = None) -> Any:
        res = await self.http.request(method, url, headers=self.headers, json=body)
        res.raise_for_status()
        return res.json()

    async def _all(self, url: str) -> list[dict[str, Any]]:
        """Every page of a cursor-paginated list."""
        out: list[dict[str, Any]] = []
        cursor = ""
        while True:
            page = obj(await self._call("GET", f"{url}?per_page=100&cursor={quote(cursor)}"))
            out += [obj(r) for r in page.get("results", [])]
            if not page.get("next_page_results") or not page.get("next_cursor"):
                return out
            cursor = str(page["next_cursor"])

    async def _group(self, ref: str) -> tuple[dict[str, Any], Group] | None:
        res = await self.http.get(
            f"{self.project}/work-items/{ref}/?expand=state", headers=self.headers
        )
        if res.status_code == 404:  # another project's item, or still in Intake
            return None
        res.raise_for_status()
        item = obj(res.json())
        group = obj(item.get("state")).get("group")
        return item, group if group in ("completed", "cancelled") else "open"

    async def search(self, query: str) -> list[Item]:
        q = query.lower()
        items = [  # search skips items still in Intake (triage state), so those come from here
            Item(str(i["issue"]), f"{self.app}/{i['issue']}", str(d.get("name")))
            for i in await self._all(f"{self.project}/intake-issues/")
            if i.get("status") in self.WAITING
            and q in str((d := obj(i.get("issue_detail"))).get("name", "")).lower()
        ][:5]
        found = await self._call(
            "GET",
            f"{self.base}/work-items/search/?limit=5&project_id={self.project_id}&search={quote(query)}",
        )
        for i in found["issues"]:  # search has no state filter: drop finished ones
            read = await self._group(i["id"])
            if read and read[1] == "open":
                items.append(Item(i["id"], f"{self.app}/{i['id']}", i["name"]))
        return items

    async def _label_ids(self, names: list[str]) -> list[str]:
        have = {str(x["name"]): str(x["id"]) for x in await self._all(f"{self.project}/labels/")}
        for n in names:
            if n not in have:
                have[n] = str(
                    (await self._call("POST", f"{self.project}/labels/", {"name": n}))["id"]
                )
        return [have[n] for n in names]

    async def create(self, producer: str, title: str, body: str) -> Item:
        cfg = producer_config(producer)
        labels = await self._label_ids(list(cfg.get("labels", [])))
        issue: dict[str, Any] = {"name": title, "description_html": _html(body)}
        if state := cfg.get("state"):
            states = await self._all(f"{self.project}/states/")
            ids = [s["id"] for s in states if s.get("name") == state]
            if not ids:
                raise KeyError(f"Plane state {state!r} not found (config/tracker.json)")
            res = await self._call(
                "POST", f"{self.project}/work-items/", {**issue, "state": ids[0], "labels": labels}
            )
            ref = str(res["id"])
        else:
            res = await self._call("POST", f"{self.project}/intake-issues/", {"issue": issue})
            raw: object = res["issue"]  # the work item's id (some servers expand it)
            ref = str(obj(raw).get("id") or raw)
            if labels:  # Intake takes no labels on create; the work item behind it does
                await self._call("PATCH", f"{self.project}/work-items/{ref}/", {"labels": labels})
        return Item(ref, f"{self.app}/{ref}", title)

    async def comment(self, ref: str, body: str) -> None:
        url = f"{self.project}/work-items/{ref}/comments/"
        await self._call("POST", url, {"comment_html": _html(body)})

    async def read(self, ref: str) -> Status | None:
        read = await self._group(ref)
        if read is None:
            return None
        item, group = read
        comments = await self._all(f"{self.project}/work-items/{ref}/comments/")
        texts = [str(item.get("description_html") or "")]
        texts += [str(c.get("comment_html") or "") for c in comments]
        return Status(f"{self.app}/{ref}", group, texts)


class GitHubIssues:
    """Optional alternative (TRACKER=github); same labels as the API's adapter."""

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

    async def create(self, producer: str, title: str, body: str) -> Item:
        labels = list(producer_config(producer).get("labels", []))
        i = await self._call(
            "POST", f"/repos/{self.repo}/issues", {"title": title, "body": body, "labels": labels}
        )
        return Item(str(i["number"]), i["html_url"], title)

    async def comment(self, ref: str, body: str) -> None:
        await self._call("POST", f"/repos/{self.repo}/issues/{ref}/comments", {"body": body})
        # The API's GitHub return-path hook only reacts to issues with this label.
        await self._call("POST", f"/repos/{self.repo}/issues/{ref}/labels", {"labels": ["support"]})

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


class DryRunTracker:
    """No tracker credentials: nothing is created, the note says what would have happened."""

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


def from_settings(http: httpx2.AsyncClient) -> Tracker:
    """TRACKER selects the adapter (plane by default); missing credentials = dry run."""
    s = settings
    if s.TRACKER == "plane":
        if s.PLANE_API_URL and s.PLANE_WORKSPACE and s.PLANE_PROJECT_ID and s.PLANE_API_TOKEN:
            return Plane(
                api_url=s.PLANE_API_URL,
                app_url=s.PLANE_APP_URL,
                workspace=s.PLANE_WORKSPACE,
                project_id=s.PLANE_PROJECT_ID,
                token=s.PLANE_API_TOKEN,
                http=http,
            )
    elif s.TRACKER == "github":
        if s.GITHUB_TOKEN and s.GITHUB_REPO:
            return GitHubIssues(s.GITHUB_REPO, s.GITHUB_TOKEN, http)
    else:
        raise ValueError(f"TRACKER must be plane or github, not {s.TRACKER!r}")
    return DryRunTracker()
