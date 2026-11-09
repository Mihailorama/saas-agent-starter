"""Service desk triage: every branch with a fake LLM and mocked Chatwoot/GitHub/Plane HTTP.

The gateway is real (Postgres + S3 from the compose stack), so the ai_calls audit is checked too.
"""

import json
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

import asyncpg
import httpx2
import pytest
import requests
from plane import PlaneClient
from requests.adapters import BaseAdapter
from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.worker import Worker

from tests.conftest import new_org
from worker import settings
from worker.activities import ModelChoice
from worker.ai import AllowedModel, Completion, Gateway, Message
from worker.s3 import S3
from worker.support import (
    Chatwoot,
    SupportActivities,
    SupportConversation,
    SupportIssueClosed,
    linked_conversations,
    parse_triage,
)
from worker.tracker import DryRunTracker, GitHub, Plane
from worker.workflows import SupportTriageWorkflow

C = SupportConversation(accountId=1, conversationId=42)
CW = "http://chatwoot.test"
LINK = f"{CW}/app/accounts/1/conversations/42"


def page(results: list[Any], next_cursor: str = "") -> dict[str, Any]:
    """A Plane cursor page with every field the SDK's models require."""
    return {
        "results": results,
        "next_cursor": next_cursor,
        "prev_cursor": "",
        "next_page_results": bool(next_cursor),
        "prev_page_results": False,
        "count": len(results),
        "total_count": len(results),
        "total_pages": 1,
        "total_results": len(results),
    }


class Fake:
    """Chatwoot + GitHub (httpx2) + Plane (the SDK's requests) on one handler; records requests."""

    current: "Fake | None" = None  # the Plane SDK's requests go to the last one created

    def __init__(self, *, attrs: dict[str, Any] | None = None, open_issues: int = 0) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.attrs: dict[str, Any] = attrs or {}
        self.open_issues = open_issues
        self.plane: dict[tuple[str, str], Any] = {}  # extra Plane routes: (method, path) -> JSON
        Fake.current = self

    def handle(self, req: httpx2.Request) -> httpx2.Response:
        body: Any = json.loads(req.content) if req.content else None
        path = req.url.path
        self.calls.append((req.method, path, body))
        conv = "/api/v1/accounts/1/conversations/42"
        if path == conv:
            sender = {"custom_attributes": {"page": "/projects/$projectId", "org_id": "org-1"}}
            return httpx2.Response(
                200, json={"custom_attributes": self.attrs, "meta": {"sender": sender}}
            )
        if path == f"{conv}/messages" and req.method == "GET":
            msgs = [
                {"message_type": 0, "content": "Upload fails, mail me at a@example.com"},
                {"message_type": 1, "content": "agent reply"},
                {"message_type": 0, "private": True, "content": "never customer text"},
            ]
            return httpx2.Response(200, json={"payload": msgs})
        if path.startswith("/api/v1/accounts/1/conversations/"):
            if path.endswith("/custom_attributes"):
                self.attrs |= body["custom_attributes"]
            return httpx2.Response(200, json={})
        if path == "/search/issues":
            items = [
                {
                    "number": 7 + n,
                    "html_url": f"https://github.com/x/y/issues/{7 + n}",
                    "title": "t",
                }
                for n in range(self.open_issues)
            ]
            return httpx2.Response(200, json={"items": items})
        if path == "/repos/x/y/issues" and req.method == "POST":
            return httpx2.Response(
                201, json={"number": 99, "html_url": "https://github.com/x/y/issues/99"}
            )
        if path == "/repos/x/y/issues/7" and req.method == "GET":
            return httpx2.Response(
                200,
                json={
                    "state": "closed",
                    "state_reason": self.attrs.get("reason", "completed"),
                    "html_url": "https://github.com/x/y/issues/7",
                    "body": f"Support conversation: {LINK}",
                },
            )
        if path == "/repos/x/y/issues/7/comments" and req.method == "GET":
            other = f"+1 user\n\nSupport conversation: {CW}/app/accounts/1/conversations/43"
            extra = self.attrs.get("gh_comments", [])
            return httpx2.Response(200, json=[{"body": other}, {"body": f"again {LINK}"}, *extra])
        plane = "/api/v1/workspaces/ws/projects/p1"
        if (req.method, path) in self.plane:
            return httpx2.Response(200, json=self.plane[req.method, path])
        if path == "/api/v1/users/me/":
            return httpx2.Response(200, json={"id": "u-bot"})  # the integration token's user
        if path == "/api/v1/workspaces/ws/work-items/search/":
            return httpx2.Response(200, json={"issues": self.attrs.get("plane_search", [])})
        if path == f"{plane}/intake-issues/" and req.method == "GET":
            # Two pages; only pending (-2) and snoozed (0) items are still open.
            last = req.url.params.get("cursor") == "100:1:0"
            results = [
                {"status": 1, "issue": "wi-accepted", "issue_detail": {"name": "Upload fails"}},
                {"status": -2, "issue": "wi-0", "issue_detail": {"name": "Upload fails twice"}},
            ]
            return httpx2.Response(
                200, json=page(results[1:], "") if last else page(results[:1], "100:1:0")
            )
        if path == f"{plane}/intake-issues/":
            return httpx2.Response(201, json={"id": "intake-1", "issue": "wi-1"})
        if path == f"{plane}/labels/" and req.method == "GET":
            return httpx2.Response(200, json=page([{"id": "l-1", "name": "from-users"}]))
        if path == f"{plane}/labels/":
            return httpx2.Response(201, json={"id": f"l-{body['name']}", "name": body["name"]})
        if path.startswith(f"{plane}/work-items/wi-") and req.method == "GET":
            if path.endswith("/comments/"):
                return httpx2.Response(200, json=page([]))
            group = self.attrs.get("plane_group", "completed")
            item = {"state": {"group": group}, "description_html": f"<p>{LINK}</p>"}
            return httpx2.Response(200, json=item)
        if path.startswith(f"{plane}/work-items/") and req.method in ("PATCH", "POST"):
            return httpx2.Response(200, json={"id": "wi-new"})  # labels, comments, create
        if path.startswith("/repos/x/y/commits/") and path.endswith("/pulls"):
            return httpx2.Response(200, json=self.attrs.get("prs", []))
        if req.method == "POST" and path.startswith("/repos/x/y/issues/"):
            return httpx2.Response(201, json={})  # comments, labels
        return httpx2.Response(404, json={})

    def client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(transport=httpx2.MockTransport(self.handle))

    def plane_client(self) -> Plane:
        return Plane(PlaneClient(base_url="http://plane.test", api_key="t"), **PLANE)

    def posted(self, suffix: str) -> list[Any]:
        return [b for m, p, b in self.calls if m == "POST" and p.endswith(suffix)]


PLANE = {"app_url": "http://plane.test", "workspace": "ws", "project_id": "p1"}


class _ToFake(BaseAdapter):
    """Sends the Plane SDK's requests to Fake.current."""

    def send(self, request: requests.PreparedRequest, *args: Any, **kwargs: Any) -> Any:
        assert Fake.current is not None
        body = request.body.encode() if isinstance(request.body, str) else request.body
        res = Fake.current.handle(
            httpx2.Request(
                str(request.method),
                str(request.url),
                headers={k: str(v) for k, v in request.headers.items()},
                content=body if isinstance(body, bytes) else b"",
            )
        )
        out = requests.Response()
        out.status_code, out.reason, out.url = res.status_code, "fake", str(request.url)
        out.headers.update(res.headers)
        out._content = res.content  # pyright: ignore[reportPrivateUsage]
        return out

    def close(self) -> None:
        pass


@pytest.fixture(autouse=True)
def plane_to_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    def adapter(_self: requests.Session, url: str) -> BaseAdapter:
        return _ToFake()

    monkeypatch.setattr(requests.Session, "get_adapter", adapter)


def llm(triage: dict[str, str] | str, duplicate: str = "0"):
    async def provider(
        model: str, messages: Sequence[Message], max_tokens: int, _tools: object = ()
    ) -> Completion:
        system = messages[0].content
        assert "a@example.com" in messages[1].content or "duplicate" in system  # gets the text
        assert "never customer text" not in messages[1].content
        if "duplicate" in system:
            return Completion(duplicate, model, 10, 1)
        text = triage if isinstance(triage, str) else json.dumps(triage)
        return Completion(text, model, 100, 50)

    return provider


@pytest.fixture(scope="session")
async def s3() -> AsyncIterator[S3]:
    s3 = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.AI_CONTENT_BUCKET,
    )
    await s3.ensure_bucket()
    yield s3
    await s3.close()


async def make(
    pool: asyncpg.Pool, s3: S3, fake: Fake, provider: Any, *, tracker: str = "github", **kw: Any
) -> tuple[SupportActivities, str]:
    org = await new_org(pool)
    ai = Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={
            ("fake", "fake-model"): AllowedModel(
                frozenset({"support.triage"}), None, unmetered=True
            )
        },
        providers={"fake": provider},
        retention_days=30,
    )
    http = fake.client()
    trackers: dict[str, Any] = {
        "github": GitHub("x/y", "test-token", http),
        "plane": fake.plane_client(),
        "dry-run": DryRunTracker(),
    }
    acts = SupportActivities(
        chatwoot=Chatwoot(CW, "cw-token", CW, http),
        tracker=trackers[tracker],
        ai=ai,
        model=ModelChoice("fake", "fake-model"),
        ai_org_id=org,
        **kw,
    )
    return acts, org


async def ai_rows(pool: asyncpg.Pool, org: str) -> list[tuple[str, str, str]]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org)
        rows = await conn.fetch(
            "select purpose, prompt_template_id, prompt_template_version, actor_id from ai_calls"
            " where org_id = $1 order by created_at",
            org,
        )
    return [
        (r["purpose"], f"{r['prompt_template_id']}.v{r['prompt_template_version']}", r["actor_id"])
        for r in rows
    ]


BUG = {"category": "bug", "title": "Upload fails", "summary": "Uploads fail.", "search": "upload"}


async def test_bug_files_a_new_issue_and_links_it(pool: asyncpg.Pool, s3: S3) -> None:
    fake = Fake()
    acts, org = await make(pool, s3, fake, llm(BUG))
    assert await acts.triage(C) == "bug"

    [issue] = fake.posted("/repos/x/y/issues")
    assert issue["labels"] == ["from-users", "support", "bug"]
    assert LINK in issue["body"] and "/projects/$projectId" in issue["body"]
    assert "a@example.com" not in issue["body"]
    [note] = [b for b in fake.posted("/messages") if b["private"]]
    assert "Filed: https://github.com/x/y/issues/99" in note["content"]
    assert fake.attrs["tracker_issue_url"] == "https://github.com/x/y/issues/99"
    assert fake.attrs["support_category"] == "bug"
    actor = "chatwoot:1/42"
    assert await ai_rows(pool, org) == [("support.triage", "support.triage/system.v1", actor)]

    # A retried activity (or a second webhook) finds the finished triage: nothing happens twice.
    before = len(fake.calls)
    assert await acts.triage(C) == "bug"
    assert len(fake.calls) == before + 1  # only the conversation read


async def test_duplicate_gets_a_plus_one_comment(pool: asyncpg.Pool, s3: S3) -> None:
    fake = Fake(open_issues=2)
    acts, org = await make(pool, s3, fake, llm(BUG, duplicate="1"))
    assert await acts.triage(C) == "bug"
    assert fake.posted("/repos/x/y/issues") == []  # nothing new filed
    [comment] = fake.posted("/issues/7/comments")
    assert comment["body"].startswith("+1 user") and LINK in comment["body"]
    assert fake.posted("/issues/7/labels") == [{"labels": ["support"]}]
    assert fake.attrs["tracker_issue_url"] == "https://github.com/x/y/issues/7"
    assert [r[1] for r in await ai_rows(pool, org)] == [
        "support.triage/system.v1",
        "support.triage/duplicate.v1",
    ]


async def test_question_gets_a_draft_note_and_is_never_sent(pool: asyncpg.Pool, s3: S3) -> None:
    fake = Fake()
    q = {"category": "question", "title": "How", "summary": "", "search": "", "answer": "Do X."}
    acts, _ = await make(pool, s3, fake, llm(q))
    assert await acts.triage(C) == "question"
    [note] = fake.posted("/messages")
    assert note["private"] is True and "Do X." in note["content"]
    assert not any(p.startswith("/repos") or p.startswith("/search") for _, p, _ in fake.calls)


@pytest.mark.parametrize("category", ["billing", "spam"])
async def test_billing_and_spam_only_get_a_note(pool: asyncpg.Pool, s3: S3, category: str) -> None:
    fake = Fake()
    acts, _ = await make(pool, s3, fake, llm({**BUG, "category": category}))
    assert await acts.triage(C) == category
    assert [b["private"] for b in fake.posted("/messages")] == [True]
    assert fake.posted("/repos/x/y/issues") == []


async def test_unusable_model_output_asks_a_human(pool: asyncpg.Pool, s3: S3) -> None:
    fake = Fake()
    acts, _ = await make(pool, s3, fake, llm("I think it is a bug."))
    assert await acts.triage(C) == "unclassified"
    assert "could not classify" in fake.posted("/messages")[0]["content"]


async def test_dry_runs(pool: asyncpg.Pool, s3: S3) -> None:
    # No tracker credentials: triage and note happen, nothing is filed.
    fake = Fake()
    acts, _ = await make(pool, s3, fake, llm(BUG), tracker="dry-run")
    assert await acts.triage(C) == "bug"
    assert "(dry run, dry-run) Upload fails" in fake.posted("/messages")[0]["content"]
    assert "tracker_issue_url" not in fake.attrs
    # No Chatwoot token: not even the conversation is read.
    off = SupportActivities(
        chatwoot=None, tracker=DryRunTracker(), ai=None, model=None, ai_org_id=""
    )
    assert await off.triage(C) == "dry-run"


async def test_plane_intake_create_and_close(pool: asyncpg.Pool, s3: S3) -> None:
    fake = Fake()
    acts, _ = await make(pool, s3, fake, llm(BUG), tracker="plane", notify="close")
    assert await acts.triage(C) == "bug"
    [intake] = fake.posted("/projects/p1/intake-issues/")
    assert intake["issue"]["name"] == "Upload fails" and LINK in intake["issue"]["description_html"]
    # config/tracker.json labels: existing ones reused, missing ones created, set on the item.
    assert fake.posted("/labels/") == [{"name": "support"}, {"name": "bug"}]
    patched = [b for m, p, b in fake.calls if m == "PATCH" and p.endswith("/work-items/wi-1/")]
    assert patched == [{"labels": ["l-1", "l-support", "l-bug"]}]
    assert fake.attrs["tracker_issue_url"] == "http://plane.test/ws/projects/p1/issues/wi-1"

    assert await acts.issue_closed(SupportIssueClosed("plane", "wi-1")) == 1
    *_, note, reply = fake.posted("/messages")
    assert note["private"] is True and "was resolved" in note["content"]
    assert "private" not in reply  # the opt-in customer message
    # A close event from the other tracker is not ours.
    assert await acts.issue_closed(SupportIssueClosed("github", "7")) == 0
    # The release comment counts while the item is still open (nobody moved it): "live in".
    fake.attrs["plane_group"] = "started"
    assert await acts.issue_closed(SupportIssueClosed("plane", "wi-1")) == 0
    # Release comments count only from our own integration user (the token's `me`).
    assert await acts.issue_closed(SupportIssueClosed("plane", "wi-1", release="v1.2.0")) == 0
    human = SupportIssueClosed("plane", "wi-1", release="v1.2.0", author="u-human")
    assert await acts.issue_closed(human) == 0
    ours = SupportIssueClosed("plane", "wi-1", release="v1.2.0", author="u-bot")
    assert await acts.issue_closed(ours) == 1
    assert "is live in v1.2.0" in fake.posted("/messages")[-1]["content"]
    assert [p for _, p, _ in fake.calls if p == "/api/v1/users/me/"] == ["/api/v1/users/me/"]
    # Never a state change: the worker only reads and comments.
    assert not [b for m, _, b in fake.calls if m == "PATCH" and "state" in b]


async def test_plane_duplicate_search_includes_intake(pool: asyncpg.Pool, s3: S3) -> None:
    fake = Fake()
    acts, _ = await make(pool, s3, fake, llm(BUG, duplicate="1"), tracker="plane")
    assert await acts.triage(C) == "bug"
    # The still-pending Intake item (second page) is the duplicate; the accepted one is not.
    assert fake.posted("/intake-issues/") == []
    [comment] = fake.posted("/work-items/wi-0/comments/")
    assert LINK in comment["comment_html"]
    assert fake.attrs["tracker_issue_url"] == "http://plane.test/ws/projects/p1/issues/wi-0"


async def test_github_close_notes_every_linked_conversation(pool: asyncpg.Pool, s3: S3) -> None:
    fake = Fake()
    acts, _ = await make(pool, s3, fake, llm(BUG))  # SUPPORT_NOTIFY_ON_CLOSE off
    assert await acts.issue_closed(SupportIssueClosed("github", "7")) == 2
    notes = fake.posted("/messages")
    assert [n["private"] for n in notes] == [True, True]  # no customer message by default
    assert {p for m, p, _ in fake.calls if m == "POST"} == {
        "/api/v1/accounts/1/conversations/42/messages",
        "/api/v1/accounts/1/conversations/43/messages",
    }
    # Release comment: "live in" note; the customer message waits for it with notify="release".
    acts.notify = "release"
    before = len(fake.posted("/messages"))
    await acts.issue_closed(SupportIssueClosed("github", "7"))  # close: notes only
    await acts.issue_closed(SupportIssueClosed("github", "7", release="v1.2.0"))
    new = fake.posted("/messages")[before:]
    assert [n.get("private", False) for n in new] == [True, True, True, False, True, False]
    assert "is live in v1.2.0" in new[2]["content"]

    fake.attrs["reason"] = "not_planned"
    acts.notify = "close"
    before = len(fake.posted("/messages"))
    await acts.issue_closed(SupportIssueClosed("github", "7"))
    later = fake.posted("/messages")[before:]
    assert [n.get("private") for n in later] == [True, True]  # not fixed: never "resolved"
    assert "not planned" in later[-1]["content"]


def test_parsing() -> None:
    t = parse_triage('Sure:\n{"category": "bug", "title": "x@example.com broke", "search": "a"}')
    assert t is not None and t.category == "bug" and "[email]" in t.title
    assert parse_triage('{"category": "rant"}') is None
    assert parse_triage("{not json}") is None
    texts = [f"{LINK} and {LINK}", "<p>http://cw/app/accounts/2/conversations/5</p>"]
    assert linked_conversations(texts) == [SupportConversation(1, 42), SupportConversation(2, 5)]


async def test_workflow_runs_once_per_conversation(pool: asyncpg.Pool) -> None:
    queue = f"test-{uuid.uuid4()}"
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    acts = SupportActivities(
        chatwoot=None, tracker=DryRunTracker(), ai=None, model=None, ai_org_id=""
    )
    c = SupportConversation(accountId=1, conversationId=int(uuid.uuid4().int % 10**9))
    # Same id scheme and reuse policy as apps/api/src/temporal.ts.
    wid = f"support-triage-{c.accountId}-{c.conversationId}"
    async with Worker(
        client, task_queue=queue, workflows=[SupportTriageWorkflow], activities=[acts.triage]
    ):
        opts: dict[str, Any] = {
            "id": wid,
            "task_queue": queue,
            "id_reuse_policy": WorkflowIDReusePolicy.REJECT_DUPLICATE,
        }
        assert await client.execute_workflow(SupportTriageWorkflow.run, c, **opts) == "dry-run"
        with pytest.raises(WorkflowAlreadyStartedError):
            await client.execute_workflow(SupportTriageWorkflow.run, c, **opts)


async def test_triage_redacts_what_it_files(pool: asyncpg.Pool, s3: S3) -> None:
    # The model may echo personal data: title, summary and the "+1" comment are redacted first.
    leaky = {
        **BUG,
        "title": "Upload fails for bob@corp.example",
        "summary": "John Smith cannot upload; call +1 415 555 0100 or bob@corp.example.",
    }
    for duplicate in ("0", "1"):  # a new item, then a "+1" on an open one
        fake = Fake(open_issues=2)
        acts, _ = await make(pool, s3, fake, llm(leaky, duplicate=duplicate))
        assert await acts.triage(C) == "bug"
        filed = [b for m, p, b in fake.calls if m == "POST" and p.startswith("/repos/x/y/issues")]
        assert filed
        text = json.dumps(filed)
        for leak in ("bob@corp.example", "John Smith", "555 0100"):
            assert leak not in text
        assert "[email]" in text and "[name]" in text
        assert ("+1 user" in text) == (duplicate == "1")
