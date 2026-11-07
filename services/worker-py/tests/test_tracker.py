"""worker/tracker.py: duplicates, safe states, closing keywords, error hygiene, the PostHog item
workflow and the release comments. Plane runs through its SDK against tests.test_support.Fake."""

import json
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx2
import pytest
import requests
from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.worker import Worker

from tests.test_support import (  # plane_to_fake: autouse fixture
    PLANE,
    Fake,
    page,
    plane_to_fake,  # noqa: F401  # pyright: ignore[reportUnusedImport]
)
from worker import released, settings
from worker.s3 import S3
from worker.tracker import (
    INBOX,
    DryRunTracker,
    GitHub,
    Plane,
    TrackerActivities,
    TrackerError,
    TrackerItem,
    find_open,
)
from worker.workflows import TrackerItemWorkflow

P = "/api/v1/workspaces/ws/projects/p1"


def hit(ref: str, name: str, project: str = "p1") -> dict[str, Any]:
    return {
        "id": ref,
        "name": name,
        "sequence_id": 1,
        "project__identifier": "APP",
        "project_id": project,
        "workspace__slug": "ws",
    }


@pytest.fixture(scope="module")
async def files() -> AsyncIterator[S3]:
    files = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.S3_BUCKET,
    )
    await files.ensure_bucket()
    yield files
    await files.close()


async def test_exact_title_duplicates_include_intake() -> None:
    fake = Fake()
    fake.attrs["plane_search"] = [
        hit("wi-5", "Upload fails"),
        hit("wi-6", "Upload fails", project="other"),  # another project of the workspace
        hit("wi-7", "Upload fails"),  # finished
        hit("wi-8", "Upload fails sometimes"),  # not the exact title
    ]
    fake.plane[("GET", f"{P}/work-items/wi-5/")] = {"state": {"group": "started"}}
    fake.plane[("GET", f"{P}/work-items/wi-7/")] = {"state": {"group": "completed"}}
    fake.plane[("GET", f"{P}/work-items/wi-8/")] = {"state": {"group": "backlog"}}
    plane = fake.plane_client()
    found = await find_open(plane, "Upload fails")
    assert found is not None and found.ref == "wi-5"
    # Still pending in Intake (second page) counts; the search never returns those.
    found = await find_open(plane, "Upload fails twice")
    assert found is not None and found.ref == "wi-0"
    assert await find_open(plane, "Something else") is None


async def test_posthog_item_is_filed_once_and_removed(files: S3) -> None:
    fake = Fake()
    acts = TrackerActivities(fake.plane_client(), files)
    key = f"{INBOX}{uuid.uuid4()}.json"
    await files.put(key, json.dumps({"title": "[cjm] signup", "body": "Breach"}).encode())
    assert await acts.file_item(TrackerItem("cjm-regression", key)) == "created"
    [intake] = fake.posted("/intake-issues/")
    assert intake["issue"]["name"] == "[cjm] signup"
    assert key not in await files.list_keys(INBOX)
    assert await acts.file_item(TrackerItem("cjm-regression", key)) == "gone"  # a retry

    # The same title while the first is still pending in Intake: a comment, not a second item.
    await files.put(key, json.dumps({"title": "Upload fails twice", "body": "Again"}).encode())
    assert await acts.file_item(TrackerItem("from-users", key)) == "commented"
    assert fake.posted("/work-items/wi-0/comments/") == [{"comment_html": "<p>Again</p>"}]
    with pytest.raises(ValueError, match="inbox"):
        await acts.file_item(TrackerItem("from-users", "privacy-exports/x.zip"))


async def test_workflow_files_once_per_text(files: S3) -> None:
    queue = f"test-{uuid.uuid4()}"
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    acts = TrackerActivities(DryRunTracker(), files)
    hashed = uuid.uuid4().hex
    item = TrackerItem("from-users", f"{INBOX}{hashed}.json")
    await files.put(item.s3Key, json.dumps({"title": "t", "body": "b"}).encode())
    # Same id scheme and reuse policy as apps/api/src/temporal.ts startTrackerItem.
    opts: dict[str, Any] = {
        "id": f"tracker-item-{hashed}",
        "task_queue": queue,
        "id_reuse_policy": WorkflowIDReusePolicy.REJECT_DUPLICATE,
    }
    async with Worker(
        client, task_queue=queue, workflows=[TrackerItemWorkflow], activities=[acts.file_item]
    ):
        assert await client.execute_workflow(TrackerItemWorkflow.run, item, **opts) == "created"
        with pytest.raises(WorkflowAlreadyStartedError):
            await client.execute_workflow(TrackerItemWorkflow.run, item, **opts)
    assert item.s3Key not in await files.list_keys(INBOX)


def states_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, state: str) -> None:
    path = tmp_path / "tracker.json"
    path.write_text(json.dumps({"producers": {"cjm-regression": {"labels": [], "state": state}}}))
    monkeypatch.setattr(settings, "TRACKER_FILE", path)


@pytest.mark.parametrize("state", ["Done", "Cancelled", "Missing"])
async def test_refuses_completed_or_unknown_target_states(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, state: str
) -> None:
    fake = Fake()
    fake.plane[("GET", f"{P}/states/")] = page(
        [
            {"id": "s-todo", "name": "Todo", "color": "#000", "group": "unstarted"},
            {"id": "s-done", "name": "Done", "color": "#000", "group": "completed"},
            {"id": "s-no", "name": "Cancelled", "color": "#000", "group": "cancelled"},
        ]
    )
    states_config(tmp_path, monkeypatch, state)
    want = "not found" if state == "Missing" else "never files items into a completed or cancelled"
    with pytest.raises(ValueError, match=want):  # worker start fails with this message
        await Plane.connect(api_url="http://plane.test", token="t", **PLANE)  # noqa: S106

    # An open state is resolved once and used for new items instead of Intake.
    states_config(tmp_path, monkeypatch, "Todo")
    plane = await Plane.connect(api_url="http://plane.test", token="t", **PLANE)  # noqa: S106
    await plane.create("cjm-regression", "[cjm] x", "body")
    assert fake.posted("/work-items/")[-1]["state"] == "s-todo"
    assert fake.posted("/intake-issues/") == []


async def test_only_closing_keywords_count() -> None:
    fake = Fake()
    fake.plane[("GET", f"{P}/")] = {"name": "App", "identifier": "APP"}
    fake.plane[("GET", "/api/v1/workspaces/ws/work-items/APP-12/")] = {"id": "wi-12"}
    plane = fake.plane_client()
    text = "fix: upload\n\nFixes APP-12, see APP-14. Closes: APP-13 (typo). Mentions APP-15."
    assert await plane.closed_by(text) == ["wi-12"]  # APP-13 is a 404, the others no keyword
    looked_up = [p for _, p, _ in fake.calls if "/work-items/APP-" in p]
    assert looked_up == [
        "/api/v1/workspaces/ws/work-items/APP-12/",
        "/api/v1/workspaces/ws/work-items/APP-13/",
    ]
    gh = GitHub("x/y", "t", fake.client())
    assert await gh.closed_by("Closes #3, refs #4. fixed: #5, resolves o/x#6, closes #3") == [
        "3",
        "5",
    ]


async def test_search_terms_stay_out_of_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def down(_self: Any, request: requests.PreparedRequest, *args: Any, **kw: Any) -> Any:
        raise requests.ConnectionError(f"Max retries exceeded with url: {request.url}")

    from tests import test_support

    monkeypatch.setattr(test_support._ToFake, "send", down)  # pyright: ignore[reportPrivateUsage]
    with pytest.raises(TrackerError) as raised:
        await Fake().plane_client().search("secret words")
    assert "secret" not in str(raised.value) and raised.value.__suppress_context__

    def refuse(req: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError(f"refused {req.url}", request=req)

    gh = GitHub("x/y", "t", httpx2.AsyncClient(transport=httpx2.MockTransport(refuse)))
    with pytest.raises(TrackerError) as raised:
        await gh.search("secret words")
    assert str(raised.value) == "GitHub API: ConnectError" and raised.value.__suppress_context__
    failing = httpx2.AsyncClient(transport=httpx2.MockTransport(lambda r: httpx2.Response(500)))
    with pytest.raises(TrackerError, match=r"^GitHub API: HTTP 500$"):
        await GitHub("x/y", "t", failing).search("secret words")


async def test_release_comments_only_on_closed_items() -> None:
    fake = Fake()
    fake.attrs["prs"] = [
        {"number": 5, "title": "fix: upload", "body": "Closes #7. See #8.", "merged_at": "t"},
        {"number": 6, "title": "Fixes #9", "body": None, "merged_at": None},  # not merged
    ]
    gh = GitHub("x/y", "t", fake.client())
    assert await released.comment_release("v1.2.0", ["abc"], gh, gh) == {"7": "commented"}
    [comment] = fake.posted("/issues/7/comments")
    assert comment["body"].startswith("Released in v1.2.0 (via #5). Release notes: ")
    # Idempotent: the comment is there now.
    fake.attrs["gh_comments"] = [comment]
    assert await released.comment_release("v1.2.0", ["abc"], gh, gh) == {"7": "already"}
    assert await released.comment_release("v1.3.0", ["abc"], gh, gh, dry_run=True) == {
        "7": "planned"
    }
    assert len(fake.posted("/issues/7/comments")) == 1
