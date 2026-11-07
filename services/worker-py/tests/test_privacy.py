"""Data-subject rights end to end against the compose stack (Temporal + Postgres + S3): export
(ZIP contents), user and organization deletion (rows/objects gone or anonymised, audit record),
cancellation in the grace period, and retention. External tools run over a mock transport."""

import dataclasses
import io
import json
import uuid
import zipfile
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import httpx2
import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from tests.conftest import new_org
from worker import settings
from worker.mail import SendEmail
from worker.privacy import (
    ChatwootContacts,
    Langfuse,
    PostHogPersons,
    PrivacyActivities,
    PrivacyRequest,
    Tools,
)
from worker.s3 import S3
from worker.workflows import DataDeletionWorkflow, DataExportWorkflow, PrivacyRetentionWorkflow

TASK_QUEUE = f"test-privacy-{uuid.uuid4()}"
SENT: list[SendEmail] = []


@activity.defn(name="send_email")
async def fake_send_email(email: SendEmail) -> str:
    SENT.append(email)
    return "<test@example.com>"


class FakeTools:
    """PostHog, Langfuse and Chatwoot over one mock transport; records every request."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def handle(self, req: httpx2.Request) -> httpx2.Response:
        path = req.url.path
        self.calls.append((req.method, path))
        if path.endswith("/persons/") and req.method == "GET":
            return httpx2.Response(200, json={"results": [{"id": "p-1", "properties": {}}]})
        if path.endswith("/query/"):
            return httpx2.Response(200, json={"columns": ["event"], "results": [["$pageview"]]})
        if path == "/api/public/traces" and req.method == "GET":
            return httpx2.Response(200, json={"data": [], "meta": {"totalPages": 1}})
        if path.startswith("/api/public/traces/"):
            return httpx2.Response(200, json={"id": path.rsplit("/", 1)[1]})
        if path.endswith("/contacts/search"):
            ident = req.url.params["q"]
            return httpx2.Response(200, json={"payload": [{"id": 7, "identifier": ident}]})
        if path.endswith("/contacts/7/conversations"):
            return httpx2.Response(200, json={"payload": [{"id": 70}]})
        if path.endswith("/conversations/70/messages"):
            return httpx2.Response(200, json={"payload": [{"content": "hello"}]})
        return httpx2.Response(200, json={})


def s3(bucket: str) -> S3:
    return S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=bucket,
    )


@pytest.fixture(scope="module")
async def env(pool: asyncpg.Pool) -> AsyncIterator[tuple[Client, PrivacyActivities, FakeTools]]:
    fake = FakeTools()
    http = httpx2.AsyncClient(transport=httpx2.MockTransport(fake.handle))
    tools = Tools(
        [
            PostHogPersons("http://posthog.test", "1", "phx_test", http),
            Langfuse("http://langfuse.test", "pk-lf", "sk-lf", http),
            ChatwootContacts("http://chatwoot.test", "1", "token", http),
        ]
    )
    files, content = s3(settings.S3_BUCKET), s3(settings.AI_CONTENT_BUCKET)
    await files.ensure_bucket()
    await content.ensure_bucket()
    acts = PrivacyActivities(pool, files=files, ai_content=content, tools=tools)
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[DataExportWorkflow, DataDeletionWorkflow, PrivacyRetentionWorkflow],
        activities=[
            acts.build_export,
            acts.mark_failed,
            acts.begin_deletion,
            acts.deletion_step,
            acts.finish_deletion,
            acts.purge_ai_content,
            acts.purge_exports,
            acts.purge_deleted_orgs,
            fake_send_email,
        ],
    ):
        yield client, acts, fake
    await http.aclose()
    await files.close()
    await content.close()


async def in_org(pool: asyncpg.Pool, org_id: str, sql: str, *args: Any) -> list[asyncpg.Record]:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        return await conn.fetch(sql, *args)


async def ai_call(
    pool: asyncpg.Pool, content: S3, org_id: str, actor: str | None, expires: datetime
) -> str:
    call_id = str(uuid.uuid4())
    prefix = f"{org_id}/2026/01/01/{call_id}"
    await content.put(f"{prefix}/request.json", b'{"messages": [{"content": "my secret"}]}')
    await content.put(f"{prefix}/response.json", b'{"text": "answer"}')
    await in_org(
        pool,
        org_id,
        "insert into ai_calls (id, org_id, actor_id, purpose, provider, request_model,"
        " prompt_template_id, prompt_template_version, request_key, response_key,"
        " content_expires_at, latency_ms, status, contour, trace_id)"
        " values ($1, $2, $3, 'project.summary', 'fake', 'm', 't', '1', $4, $5, $6, 1, 'ok',"
        " 'eu', $7) returning id",
        call_id,
        org_id,
        actor,
        f"{prefix}/request.json",
        f"{prefix}/response.json",
        expires,
        uuid.uuid4().hex,
    )
    return prefix


async def exists(store: S3, key: str) -> bool:
    try:
        await store.get(key)
        return True
    except httpx2.HTTPStatusError as err:
        assert err.response.status_code == 404
        return False


async def person(pool: asyncpg.Pool, acts: PrivacyActivities) -> dict[str, str]:
    """A user with an account, a session, an org membership, an audit row with an IP, an AI call
    with stored content, a reviewed project and an uploaded file."""
    uid, org_id = str(uuid.uuid4()), await new_org(pool)
    await pool.execute(
        'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
        uid,
        "Ada Example",
        f"{uid}@example.com",
    )
    await pool.execute(
        "insert into account (id, account_id, provider_id, user_id, password)"
        " values ($1, $1, 'credential', $1, 'hash-never-exported')",
        uid,
    )
    await pool.execute(
        "insert into session (id, expires_at, token, user_id, ip_address)"
        " values ($1, now() + interval '1 day', $2, $3, '192.0.2.1')",
        str(uuid.uuid4()),
        f"tok-{uid}",
        uid,
    )
    await pool.execute(
        "insert into member (id, organization_id, user_id, role, created_at)"
        " values ($1, $2, $3, 'member', now())",
        str(uuid.uuid4()),
        org_id,
        uid,
    )
    project, attachment = str(uuid.uuid4()), str(uuid.uuid4())
    await in_org(
        pool,
        org_id,
        "insert into projects (id, org_id, name, reviewed_by) values ($1, $2, 'P', $3)"
        " returning id",
        project,
        org_id,
        uid,
    )
    await in_org(
        pool,
        org_id,
        "insert into attachments (id, org_id, project_id, filename, content_type, size,"
        " created_by) values ($1, $2, $3, 'cv.txt', 'text/plain', 5, $4) returning id",
        attachment,
        org_id,
        project,
        uid,
    )
    file_key = f"{org_id}/{project}/{attachment}"
    await acts.files.put(file_key, b"hello", "text/plain")
    await in_org(
        pool,
        org_id,
        "insert into audit_log (org_id, actor_id, action, ip) values ($1, $2, 'x', '192.0.2.1')"
        " returning id",
        org_id,
        uid,
    )
    prefix = await ai_call(
        pool, acts.ai_content, org_id, uid, datetime.now(UTC) + timedelta(days=30)
    )
    return {"uid": uid, "org": org_id, "file": file_key, "ai": prefix, "attachment": attachment}


async def new_request(
    pool: asyncpg.Pool, kind: str, subject_type: str, subject_id: str, after: datetime
) -> PrivacyRequest:
    rid = await pool.fetchval(
        "insert into privacy_requests (kind, subject_type, subject_id, requested_by, status,"
        " execute_after) values ($1, $2, $3, $3, $4, $5) returning id::text",
        kind,
        subject_type,
        subject_id,
        "scheduled" if kind == "deletion" else "running",
        after,
    )
    return PrivacyRequest(rid, kind, subject_type, subject_id, after.isoformat())


async def test_user_export_zip(
    env: tuple[Client, PrivacyActivities, FakeTools],
    pool: asyncpg.Pool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, acts, fake = env
    monkeypatch.setattr(settings, "EMAIL_TASK_QUEUE", TASK_QUEUE)  # the fake mailer above
    p = await person(pool, acts)
    req = await new_request(pool, "export", "user", p["uid"], datetime.now(UTC))
    mail = SendEmail("data-export-ready", "a@example.com", "Ready", "<p>x</p>", "x")
    req = dataclasses.replace(req, email=mail)

    await client.execute_workflow(
        DataExportWorkflow.run, req, id=f"privacy-export-{req.requestId}", task_queue=TASK_QUEUE
    )

    row = await pool.fetchrow("select * from privacy_requests where id = $1", req.requestId)
    assert (
        row is not None and row["status"] == "completed" and row["expires_at"] > row["created_at"]
    )
    z = zipfile.ZipFile(io.BytesIO(await acts.files.get(row["result_key"])))
    names = set(z.namelist())
    assert {"README.md", "db/user.json", "db/account.json", "db/session.json"} <= names
    assert f"files/attachments/{p['attachment']}-cv.txt" in names
    assert f"files/ai-content/{p['ai']}/request.json" in names
    assert {"tools/posthog.json", "tools/langfuse.json", "tools/chatwoot.json"} <= names
    user = json.loads(z.read("db/user.json"))
    assert user[0]["email"] == f"{p['uid']}@example.com"
    # Secrets never leave the database, not even towards their owner.
    assert "password" not in json.loads(z.read("db/account.json"))[0]
    assert "token" not in json.loads(z.read("db/session.json"))[0]
    assert json.loads(z.read("db/audit_log.json"))[0]["ip"] == "192.0.2.1"
    assert z.read(f"files/attachments/{p['attachment']}-cv.txt") == b"hello"
    chatwoot = json.loads(z.read("tools/chatwoot.json"))
    assert chatwoot["contacts"][0]["conversations"][0]["messages"] == [{"content": "hello"}]
    readme = z.read("README.md").decode()
    assert "error_tracking" in readme and "umami" in readme
    assert SENT[-1] == mail
    assert ("POST", "/api/projects/1/query/") in fake.calls


async def test_user_deletion_everywhere(
    env: tuple[Client, PrivacyActivities, FakeTools], pool: asyncpg.Pool
) -> None:
    client, acts, fake = env
    p = await person(pool, acts)
    req = await new_request(pool, "deletion", "user", p["uid"], datetime.now(UTC))

    report = await client.execute_workflow(
        DataDeletionWorkflow.run, req, id=f"privacy-deletion-{req.requestId}", task_queue=TASK_QUEUE
    )

    uid, org = p["uid"], p["org"]
    assert await pool.fetchval('select count(*) from "user" where id = $1', uid) == 0
    for table in ("session", "account", "member"):
        n = await pool.fetchval(f"select count(*) from {table} where user_id = $1", uid)  # noqa: S608
        assert n == 0, table
    # Kept as the legal record, without the IP; the AI call row stays, its content is gone.
    audit = await in_org(pool, org, "select ip from audit_log where actor_id = $1", uid)
    assert [r["ip"] for r in audit] == [None]
    assert len(await in_org(pool, org, "select 1 from ai_calls where actor_id = $1", uid)) == 1
    assert not await exists(acts.ai_content, f"{p['ai']}/request.json")
    # Organization data stays, without the link to the person.
    assert await exists(acts.files, p["file"])
    att = await in_org(
        pool, org, "select created_by from attachments where id = $1", p["attachment"]
    )
    assert att[0]["created_by"] is None
    assert (await in_org(pool, org, "select reviewed_by from projects"))[0]["reviewed_by"] is None

    for step in ("sessions", "posthog", "langfuse", "chatwoot", "storage", "database"):
        assert report[step]["status"] == "done", (step, report[step])
    assert report["ga4"]["status"] == "skipped"  # not configured here
    assert ("DELETE", "/api/projects/1/persons/p-1/") in fake.calls
    assert ("DELETE", "/api/public/traces") in fake.calls
    assert ("DELETE", "/api/v1/accounts/1/contacts/7") in fake.calls
    row = await pool.fetchrow("select * from privacy_requests where id = $1", req.requestId)
    assert row is not None and row["status"] == "completed"
    stored = json.loads(row["report"])
    assert stored["database"]["status"] == "done" and "umami" in stored
    assert uid not in json.dumps({k: v for k, v in stored.items()})  # non-personal record


async def test_cancel_in_grace_period(
    env: tuple[Client, PrivacyActivities, FakeTools], pool: asyncpg.Pool
) -> None:
    client, acts, _ = env
    p = await person(pool, acts)
    req = await new_request(
        pool, "deletion", "user", p["uid"], datetime.now(UTC) + timedelta(hours=1)
    )
    handle = await client.start_workflow(
        DataDeletionWorkflow.run, req, id=f"privacy-deletion-{req.requestId}", task_queue=TASK_QUEUE
    )
    # What POST .../cancel does: the row first, then the signal.
    await pool.execute(
        "update privacy_requests set status = 'cancelled' where id = $1", req.requestId
    )
    await handle.signal(DataDeletionWorkflow.cancel)
    assert await handle.result() == {"status": "cancelled"}
    assert await pool.fetchval('select count(*) from "user" where id = $1', p["uid"]) == 1
    assert await exists(acts.ai_content, f"{p['ai']}/request.json")


async def test_org_deletion_then_record_purge(
    env: tuple[Client, PrivacyActivities, FakeTools], pool: asyncpg.Pool
) -> None:
    client, acts, _ = env
    p = await person(pool, acts)
    org = p["org"]
    await pool.execute(
        "insert into apikey (id, reference_id, key, created_at, updated_at)"
        " values ($1, $2, $1, now(), now())",
        str(uuid.uuid4()),
        org,
    )
    endpoint = str(uuid.uuid4())
    await in_org(
        pool,
        org,
        "insert into webhook_endpoints (id, org_id, url, event_types, secret)"
        " values ($1, $2, 'https://example.com/hook', '{project.created}', 'x') returning id",
        endpoint,
        org,
    )
    req = await new_request(pool, "deletion", "org", org, datetime.now(UTC))
    report = await client.execute_workflow(
        DataDeletionWorkflow.run, req, id=f"privacy-deletion-{req.requestId}", task_queue=TASK_QUEUE
    )
    for step in ("access", "webhooks", "storage", "database"):
        assert report[step]["status"] == "done", (step, report[step])
    assert report["billing"]["status"] == "skipped"
    assert await pool.fetchval("select count(*) from apikey where reference_id = $1", org) == 0
    assert await pool.fetchval("select count(*) from member where organization_id = $1", org) == 0
    assert await in_org(pool, org, "select 1 from projects") == []
    assert await in_org(pool, org, "select 1 from webhook_endpoints") == []
    assert not await exists(acts.files, p["file"])
    assert not await exists(acts.ai_content, f"{p['ai']}/request.json")
    name = await pool.fetchval("select name from organization where id = $1", org)
    assert name == "Deleted organization"
    # The record (ai_calls, audit_log) stays for the record period...
    assert len(await in_org(pool, org, "select 1 from ai_calls")) == 1
    assert [r["ip"] for r in await in_org(pool, org, "select ip from audit_log")] == [None]
    row = await pool.fetchrow("select * from privacy_requests where id = $1", req.requestId)
    assert row is not None and row["expires_at"] > datetime.now(UTC) + timedelta(days=170)

    # ...and goes with the organization row once that period has passed.
    await pool.execute(
        "update privacy_requests set expires_at = now() - interval '1 second' where id = $1",
        req.requestId,
    )
    assert await acts.purge_deleted_orgs() >= 1
    assert await pool.fetchval("select count(*) from organization where id = $1", org) == 0
    assert await in_org(pool, org, "select 1 from ai_calls") == []
    assert (
        await pool.fetchval("select status from privacy_requests where id = $1", req.requestId)
        == "completed"
    )


async def test_retention_deletes_expired_content_keeps_metadata(
    env: tuple[Client, PrivacyActivities, FakeTools], pool: asyncpg.Pool
) -> None:
    client, acts, _ = env
    org = await new_org(pool)
    now = datetime.now(UTC)
    expired = await ai_call(pool, acts.ai_content, org, None, now - timedelta(minutes=1))
    current = await ai_call(pool, acts.ai_content, org, None, now + timedelta(days=1))
    export_key = f"privacy-exports/{uuid.uuid4()}.zip"
    await acts.files.put(export_key, b"zip", "application/zip")
    export_id = await pool.fetchval(
        "insert into privacy_requests (kind, subject_type, subject_id, requested_by, status,"
        " result_key, expires_at) values ('export', 'user', 'u', 'u', 'completed', $1,"
        " now() - interval '1 second') returning id",
        export_key,
    )

    result = await client.execute_workflow(
        PrivacyRetentionWorkflow.run, id=f"privacy-retention-{uuid.uuid4()}", task_queue=TASK_QUEUE
    )

    assert result["calls"] >= 1 and result["exports"] >= 1 and result["until"]
    assert not await exists(acts.ai_content, f"{expired}/request.json")
    assert not await exists(acts.ai_content, f"{expired}/response.json")
    assert await exists(acts.ai_content, f"{current}/request.json")
    # Metadata rows remain for both calls: only the content had a retention date.
    keys = await in_org(pool, org, "select request_key from ai_calls order by content_expires_at")
    assert [r["request_key"] for r in keys] == [
        f"{expired}/request.json",
        f"{current}/request.json",
    ]
    assert not await exists(acts.files, export_key)
    assert (
        await pool.fetchval("select result_key from privacy_requests where id = $1", export_id)
        is None
    )

    # The next run starts where this one stopped: the already purged call is not visited again.
    again = await acts.purge_ai_content(result["until"])
    assert again["calls"] == 0
