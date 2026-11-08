"""Data-subject rights (docs/privacy.md, docs/adr/0022-data-subject-rights.md).

Export and deletion of one user's or one organization's data in our database, S3 and every
configured external tool, plus the retention schedule that enforces recorded expiry dates.
The API creates a `privacy_requests` row and starts DataExportWorkflow / DataDeletionWorkflow
(worker/workflows.py); the row and its `report` are the audit record, progress is the workflow
history. Logs and reports carry ids, counts and error classes, never personal data.
"""

from __future__ import annotations

import io
import json
import logging
import re
import time
import zipfile
from base64 import urlsafe_b64encode
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Protocol, cast
from uuid import UUID

import asyncpg
import httpx2
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker import settings
from worker.crm import BOOKING_PREFIX
from worker.mail import SendEmail
from worker.s3 import S3, NotFound
from worker.tracker import INBOX

log = logging.getLogger(__name__)

Doc = dict[str, Any]
if TYPE_CHECKING:
    from asyncpg.pool import PoolConnectionProxy

    Conn = PoolConnectionProxy[asyncpg.Record]  # generic only in the stubs
# Export attempts before a tool that keeps failing is listed as "failed" instead of retried.
EXPORT_ATTEMPTS = 5
EXPORT_PREFIX = "privacy-exports/"
# Better Auth stores several roles comma-separated (same test as apps/api/src/routes/privacy.ts).
OWNER_ROLE = r"(^|,)\s*owner\s*(,|$)"
# Columns that never leave the database, not even in the subject's own export.
SECRET_COLUMNS = {
    "account": {"password", "access_token", "refresh_token", "id_token"},
    "session": {"token"},
    "two_factor": {"secret", "backup_codes"},
    "passkey": {"public_key"},
    "apikey": {"key"},
    "webhook_endpoints": {"secret", "previous_secret"},
    "mcp_servers": {"auth_secret"},
}


@dataclass(frozen=True)
class PrivacyRequest:
    """Workflow input. Contract with `PrivacyRequest` in apps/api/src/temporal.ts."""

    requestId: str
    kind: str  # export | deletion
    subjectType: str  # user | org
    subjectId: str
    executeAfter: str  # ISO time; a deletion waits until then
    email: SendEmail | None = None
    gaClientId: str = ""


@dataclass(frozen=True)
class Step:
    request: PrivacyRequest
    name: str


@dataclass(frozen=True)
class Finish:
    request: PrivacyRequest
    report: dict[str, Doc]


@dataclass(frozen=True)
class Subject:
    """What a tool adapter needs to find one subject's data."""

    type: str  # user | org
    id: str
    trace_ids: Sequence[str] = ()  # OpenTelemetry traces of the subject's AI calls
    ga_client_id: str = ""


def outcome(status: str, detail: str = "", **counts: int) -> Doc:
    """One report entry: done | skipped | not_supported | failed, a reason, and counts."""
    return {"status": status, "detail": detail, **({"counts": counts} if counts else {})}


# Tools that hold nothing per person by design: listed in every report so it is complete.
STATIC = {
    "error_tracking": outcome(
        "not_supported",
        "GlitchTip/Sentry events carry no user, request or extra data (scrubbed by the SDK "
        "setup in apps/api, apps/web and the worker), so nothing can be found per person; "
        "Sentry has no delete-by-user API either. Events expire with the tracker's retention "
        "(GlitchTip GLITCHTIP_RETENTION_DAYS, default 90; Sentry 30 or 90 days by plan)",
    ),
    "umami": outcome(
        "not_supported",
        "Umami is cookieless and the app never calls umami.identify: its sessions are hashes "
        "with a rotating salt that cannot be linked to a user",
    ),
}
ORG_STATIC = {
    "posthog": outcome("not_supported", "per person: each member's own deletion removes it"),
    "chatwoot": outcome("not_supported", "per person: each member's own deletion removes it"),
    "ga4": outcome("not_supported", "per browser: each member's own deletion removes it"),
}


def jsonable(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in cast(dict[Any, Any], value).items()}
    if isinstance(value, list | tuple):
        return [jsonable(v) for v in cast(list[Any], value)]
    return value


def obj(value: object) -> Doc:
    """A JSON object from an API response, or {} for anything else."""
    return cast(Doc, value) if isinstance(value, dict) else {}


def objs(value: object) -> list[Doc]:
    """The JSON objects in a JSON array from an API response."""
    return [obj(v) for v in cast(list[object], value)] if isinstance(value, list) else []


def rows(table: str, records: Sequence[asyncpg.Record]) -> list[Doc]:
    hidden = SECRET_COLUMNS.get(table, set())
    return [{k: jsonable(v) for k, v in r.items() if k not in hidden} for r in records]


class ToolError(ApplicationError):
    """An HTTP failure of an external tool. The message is ours: tool name + status only."""


async def call(
    http: httpx2.AsyncClient,
    tool: str,
    method: str,
    url: str,
    retry: tuple[int, ...] = (),
    **kw: Any,
) -> Any:
    try:
        res = await http.request(method, url, **kw)
    except httpx2.HTTPError as err:  # class only: messages can echo the URL with ids
        raise ToolError(f"{tool} {type(err).__name__}") from None
    if res.status_code >= 400:
        # Client errors other than 404/408/409/429 (and `retry`) will not fix themselves.
        transient = (404, 408, 409, 429, *retry)
        permanent = res.status_code < 500 and res.status_code not in transient
        raise ToolError(f"{tool} HTTP {res.status_code}", non_retryable=permanent)
    return res.json() if res.content else None


class Tool(Protocol):
    name: str
    subjects: frozenset[str]  # user and/or org

    async def export(self, s: Subject) -> Doc: ...
    async def delete(self, s: Subject) -> Doc: ...


class PostHogPersons:
    """PostHog persons and their events (https://posthog.com/docs/api/persons; personal API key
    with person:read, person:write, query:read). The web identifies users by user id, and the
    worker's `$ai_generation` events use the same distinct id."""

    name = "posthog"
    subjects = frozenset({"user"})

    def __init__(self, host: str, project_id: str, key: str, http: httpx2.AsyncClient) -> None:
        self.base = f"{host.rstrip('/')}/api/projects/{project_id}"
        self.http, self.headers = http, {"authorization": f"Bearer {key}"}

    async def export(self, s: Subject) -> Doc:
        found = await call(
            self.http,
            self.name,
            "GET",
            f"{self.base}/persons/",
            params={"distinct_id": s.id},
            headers=self.headers,
        )
        query = {
            "kind": "HogQLQuery",
            # The id is a placeholder value, never spliced into the query text.
            "query": "select uuid, event, timestamp, properties from events"
            " where distinct_id = {distinct_id} order by timestamp limit 50000",
            "values": {"distinct_id": s.id},
        }
        events = obj(
            await call(
                self.http,
                self.name,
                "POST",
                f"{self.base}/query/",
                json={"query": query},
                headers=self.headers,
            )
        )
        return {
            "persons": objs(obj(found).get("results")),
            "events": {"columns": events.get("columns"), "rows": events.get("results") or []},
        }

    async def delete(self, s: Subject) -> Doc:
        # Persons by distinct id, with their events and recordings. PostHog queues the event
        # deletion and runs it in a batch job (weekly on PostHog Cloud).
        res = obj(
            await call(
                self.http,
                self.name,
                "POST",
                f"{self.base}/persons/bulk_delete/",
                json={"distinct_ids": [s.id], "delete_events": True, "delete_recordings": True},
                headers=self.headers,
            )
        )
        if res.get("deletion_errors"):
            raise ToolError(f"{self.name} deletion_errors")
        queued = len(cast(list[Any], res.get("persons_queued_for_deletion") or []))
        return outcome(
            "done", "persons deleted, events queued for PostHog's batch deletion", persons=queued
        )


class Langfuse:
    """Langfuse public API (Basic auth with the project key pair; v2 observations and v3 scores,
    https://langfuse.com/faq/all/deprecated-api-migration). Our spans carry no user id, so the
    subject's traces are those of their AI calls (ai_calls.trace_id); traces a deployment files
    under the user id (`langfuse.user.id`) are found too."""

    name = "langfuse"
    subjects = frozenset({"user", "org"})

    def __init__(self, host: str, public: str, secret: str, http: httpx2.AsyncClient) -> None:
        self.base = f"{host.rstrip('/')}/api/public"
        self.http, self.auth = http, httpx2.BasicAuth(public, secret)

    async def _pages(self, path: str, **params: Any) -> list[Doc]:
        out: list[Doc] = []
        cursor = ""
        while True:
            page = obj(
                await call(
                    self.http,
                    self.name,
                    "GET",
                    f"{self.base}{path}",
                    params={**params, **({"cursor": cursor} if cursor else {})},
                    auth=self.auth,
                )
            )
            out += objs(page.get("data"))
            cursor = str(obj(page.get("meta")).get("cursor") or "")
            if not cursor:
                return out

    async def _trace_ids(self, s: Subject) -> list[str]:
        ids = list(dict.fromkeys(s.trace_ids))
        if s.type == "user":
            for o in await self._pages("/v2/observations", userId=s.id, fields="core", limit=1000):
                if o.get("traceId") and o["traceId"] not in ids:
                    ids.append(str(o["traceId"]))
        return ids

    async def export(self, s: Subject) -> Doc:
        ids = await self._trace_ids(s)
        observations: list[Doc] = []
        for trace_id in ids:
            observations += await self._pages(
                "/v2/observations",
                traceId=trace_id,
                fields="core,basic,time,io,metadata,model,usage",
                limit=1000,
            )
        scores: list[Doc] = []
        for i in range(0, len(ids), 50):
            scores += await self._pages("/v3/scores", traceId=",".join(ids[i : i + 50]), limit=100)
        return {"traceIds": ids, "observations": observations, "scores": scores}

    async def delete(self, s: Subject) -> Doc:
        ids = await self._trace_ids(s)
        for i in range(0, len(ids), 1000):
            await call(
                self.http,
                self.name,
                "DELETE",
                f"{self.base}/traces",
                json={"traceIds": ids[i : i + 1000]},
                auth=self.auth,
            )
        # Langfuse deletes observations and scores with the trace, usually within 15 minutes.
        return outcome("done", "traces with their observations and scores", traces=len(ids))


class ChatwootContacts:
    """Chatwoot application API (`api_access_token` of an administrator: agents and agent bots
    cannot delete contacts). The widget identifies a signed-in user with identifier = user id."""

    name = "chatwoot"
    subjects = frozenset({"user"})

    def __init__(self, url: str, account_id: str, token: str, http: httpx2.AsyncClient) -> None:
        self.base = f"{url.rstrip('/')}/api/v1/accounts/{account_id}"
        self.http, self.headers = http, {"api_access_token": token}

    async def _get(self, path: str, **params: Any) -> Any:
        return await call(
            self.http, self.name, "GET", f"{self.base}{path}", params=params, headers=self.headers
        )

    async def _contacts(self, s: Subject) -> list[Doc]:
        found = await self._get("/contacts/search", q=s.id)
        # q is a substring match on name, email, phone and identifier: keep exact matches only.
        return [c for c in objs(obj(found).get("payload")) if c.get("identifier") == s.id]

    async def export(self, s: Subject) -> Doc:
        contacts: list[Doc] = []
        for c in await self._contacts(s):
            conversations: list[Doc] = []
            found = await self._get(f"/contacts/{c['id']}/conversations")
            for conv in objs(obj(found).get("payload")):
                messages = await self._get(f"/conversations/{conv['id']}/messages")
                conversations.append({**conv, "messages": objs(obj(messages).get("payload"))})
            contacts.append({**c, "conversations": conversations})
        return {"contacts": contacts}

    async def delete(self, s: Subject) -> Doc:
        contacts = await self._contacts(s)
        for c in contacts:
            # Conversations and messages go with the contact (destroy_async). 422 = the contact
            # is online right now: retried later.
            await call(
                self.http,
                self.name,
                "DELETE",
                f"{self.base}/contacts/{c['id']}",
                retry=(422,),
                headers=self.headers,
            )
        return outcome("done", "contacts with their conversations", contacts=len(contacts))


class Ga4UserDeletion:
    """GA4 user deletion (Admin API properties.submitUserDeletion) by the client id of the
    browser the deletion was requested from: the web sends no user id to GA4. Service account
    with access to the property; OAuth scope analytics.edit."""

    name = "ga4"
    subjects = frozenset({"user"})
    SCOPE = "https://www.googleapis.com/auth/analytics.edit"
    URL = "https://analyticsadmin.googleapis.com/v1alpha/properties/{}:submitUserDeletion"

    def __init__(self, property_id: str, service_account: Doc, http: httpx2.AsyncClient) -> None:
        self.property_id, self.sa, self.http = property_id, service_account, http

    async def _token(self) -> str:
        """OAuth 2.0 JWT bearer grant (RFC 7523), signed RS256 with the service account key using
        the `cryptography` package we already depend on, instead of adding google-auth."""
        now = int(time.time())
        token_uri = str(self.sa.get("token_uri", "https://oauth2.googleapis.com/token"))

        def enc(doc: Doc) -> bytes:
            return urlsafe_b64encode(json.dumps(doc).encode()).rstrip(b"=")

        claims = {
            "iss": self.sa["client_email"],
            "scope": self.SCOPE,
            "aud": token_uri,
            "iat": now,
            "exp": now + 600,
        }
        unsigned = enc({"alg": "RS256", "typ": "JWT"}) + b"." + enc(claims)
        key = serialization.load_pem_private_key(str(self.sa["private_key"]).encode(), None)
        if not isinstance(key, rsa.RSAPrivateKey):
            raise ApplicationError("GA4 service account key is not RSA", non_retryable=True)
        sig = urlsafe_b64encode(key.sign(unsigned, padding.PKCS1v15(), hashes.SHA256()))
        res = await call(
            self.http,
            self.name,
            "POST",
            token_uri,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": (unsigned + b"." + sig.rstrip(b"=")).decode(),
            },
        )
        return str(obj(res)["access_token"])

    async def export(self, s: Subject) -> Doc:
        raise NotImplementedError  # listed in NOT_EXPORTABLE, never called

    async def delete(self, s: Subject) -> Doc:
        if not s.ga_client_id:
            return outcome(
                "skipped", "no GA4 client id: the request came from a browser without one"
            )
        headers = {"authorization": f"Bearer {await self._token()}"}
        await call(
            self.http,
            self.name,
            "POST",
            self.URL.format(self.property_id),
            json={"clientId": s.ga_client_id},
            headers=headers,
        )
        return outcome("done", "GA4 deletes the client id's data in its own processing window")


class TwentyCrm:
    """Twenty CRM (docs/crm.md), the same REST API and key as the sync (worker/crm.py). A user is
    the person with appUserId = user id; an organization is the company and the deal with
    appOrgId = org id. Both come with the notes the sync wrote on them (appEventId set). Deletes
    are Twenty's destroy, a hard delete: `DELETE /rest/<object>/<id>` without `soft_delete=true`
    (twenty-server rest-api-core.service.ts, v2.56.1); its UI "Delete" is the soft one."""

    name = "twenty"
    subjects = frozenset({"user", "org"})

    def __init__(self, url: str, token: str, http: httpx2.AsyncClient) -> None:
        self.base = f"{url.rstrip('/')}/rest"
        self.http, self.headers = http, {"authorization": f"Bearer {token}"}

    async def _get(self, path: str, **params: str) -> Doc:
        found = await call(
            self.http, self.name, "GET", f"{self.base}{path}", params=params, headers=self.headers
        )
        return obj(obj(found).get("data"))

    async def _list(self, plural: str, field: str, value: str) -> list[Doc]:
        # ponytail: first 200 matches; a person or company has a handful of sync notes.
        found = await self._get(f"/{plural}", filter=f'{field}[eq]:"{value}"', limit="200")
        return objs(found.get(plural))

    async def _records(self, s: Subject) -> dict[str, list[Doc]]:
        if s.type == "user":
            records = {"people": await self._list("people", "appUserId", s.id)}
            targets = [("targetPersonId", p["id"]) for p in records["people"]]
        else:
            records = {
                "companies": await self._list("companies", "appOrgId", s.id),
                "opportunities": await self._list("opportunities", "appOrgId", s.id),
            }
            targets = [("targetCompanyId", c["id"]) for c in records["companies"]]
        notes: dict[str, Doc] = {}
        for key, target in targets:
            for t in await self._list("noteTargets", key, target):
                note = obj((await self._get(f"/notes/{t['noteId']}")).get("note"))
                if note.get("appEventId"):  # written by the sync, not by a person in the CRM
                    notes[note["id"]] = note
        records["notes"] = list(notes.values())
        return records

    async def export(self, s: Subject) -> Doc:
        return await self._records(s)

    async def delete(self, s: Subject) -> Doc:
        records = await self._records(s)
        for plural in ("notes", "opportunities", "people", "companies"):
            for r in records.get(plural, []):
                await call(
                    self.http,
                    self.name,
                    "DELETE",
                    f"{self.base}/{plural}/{r['id']}",
                    params={"soft_delete": "false"},
                    headers=self.headers,
                )
        return outcome(
            "done",
            "destroyed (hard delete); notes people wrote in Twenty stay, without the link",
            **{k: len(v) for k, v in records.items()},
        )


# Tools with no per-person export API: listed in the ZIP's README instead.
NOT_EXPORTABLE = {
    "ga4": "GA4 has no API that returns one user's events (raw events only via a BigQuery export)",
}


@dataclass
class Tools:
    """The configured external tools (settings decide; unset = not configured, skipped)."""

    all: list[Tool] = field(default_factory=list[Tool])

    def for_subject(self, subject_type: str) -> list[Tool]:
        return [t for t in self.all if subject_type in t.subjects]


def configured_tools(http: httpx2.AsyncClient) -> Tools:
    s = settings
    tools: list[Tool] = []
    if s.POSTHOG_APP_HOST and s.POSTHOG_PROJECT_ID and s.POSTHOG_PERSONAL_API_KEY:
        tools.append(
            PostHogPersons(
                s.POSTHOG_APP_HOST, s.POSTHOG_PROJECT_ID, s.POSTHOG_PERSONAL_API_KEY, http
            )
        )
    if s.LANGFUSE_HOST and s.LANGFUSE_PUBLIC_KEY and s.LANGFUSE_SECRET_KEY:
        tools.append(Langfuse(s.LANGFUSE_HOST, s.LANGFUSE_PUBLIC_KEY, s.LANGFUSE_SECRET_KEY, http))
    if s.CHATWOOT_URL and s.CHATWOOT_ACCOUNT_ID and s.CHATWOOT_ADMIN_API_TOKEN:
        tools.append(
            ChatwootContacts(
                s.CHATWOOT_URL, s.CHATWOOT_ACCOUNT_ID, s.CHATWOOT_ADMIN_API_TOKEN, http
            )
        )
    if s.TWENTY_API_URL and s.TWENTY_API_KEY:
        tools.append(TwentyCrm(s.TWENTY_API_URL, s.TWENTY_API_KEY, http))
    if s.GA4_PROPERTY_ID and s.GA4_SERVICE_ACCOUNT_JSON:
        tools.append(
            Ga4UserDeletion(s.GA4_PROPERTY_ID, json.loads(s.GA4_SERVICE_ACCOUNT_JSON), http)
        )
    return Tools(tools)


def zip_bytes(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


def readme(req: PrivacyRequest, sources: dict[str, Doc], generated: datetime) -> bytes:
    lines = [
        "# Data export",
        "",
        f"Subject: {req.subjectType} `{req.subjectId}`. Generated: {generated.isoformat()}.",
        "",
        "Every file is JSON. `db/` holds rows from our database (secrets such as password hashes,",
        "session tokens and key hashes are left out), `files/` the stored files (uploads, AI",
        "request/response content), `tools/` what each external tool returned for this subject.",
        "",
        "## Sources",
        "",
    ]
    for name, o in sources.items():
        detail = f": {o['detail']}" if o.get("detail") else ""
        lines.append(f"- **{name}**: {o['status']}{detail}")
    return ("\n".join(lines) + "\n").encode()


class PrivacyActivities:
    def __init__(
        self,
        pool: asyncpg.Pool,
        *,
        files: S3,
        ai_content: S3,
        tools: Tools,
        export_ttl_days: int = 7,
        org_records_days: int = 180,
        booking_days: int = 7,
    ) -> None:
        self.pool, self.files, self.ai_content, self.tools = pool, files, ai_content, tools
        self.export_ttl = timedelta(days=export_ttl_days)
        self.org_records = timedelta(days=org_records_days)
        self.booking_days = booking_days

    # --- helpers -------------------------------------------------------------------------

    async def _org_ids(self) -> list[str]:
        # ponytail: a user's rows can be in any organization (also ones they left), so every
        # organization is visited, one RLS transaction each; fine for thousands of orgs.
        return [r["id"] for r in await self.pool.fetch("select id from organization")]

    async def _in_org(self, org_id: str, fn: Callable[[Conn], Awaitable[Any]]) -> Any:
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", org_id)
            return await fn(conn)

    async def _each_org(self, s: Subject, fn: Callable[[Conn, str], Awaitable[Any]]) -> list[Any]:
        orgs = [s.id] if s.type == "org" else await self._org_ids()
        out: list[Any] = []
        for org_id in orgs:

            async def run(conn: Conn, org_id: str = org_id) -> Any:
                return await fn(conn, org_id)

            out.append(await self._in_org(org_id, run))
        return out

    async def _ai_calls(self, s: Subject) -> list[asyncpg.Record]:
        where = "true" if s.type == "org" else "actor_id = $1"
        args = [] if s.type == "org" else [s.id]

        async def q(conn: Conn, _: str) -> list[asyncpg.Record]:
            return await conn.fetch(f"select * from ai_calls where {where}", *args)  # noqa: S608

        return [r for batch in await self._each_org(s, q) for r in batch]

    async def subject(self, req: PrivacyRequest) -> Subject:
        calls = await self._ai_calls(Subject(req.subjectType, req.subjectId))
        return Subject(
            req.subjectType,
            req.subjectId,
            trace_ids=[r["trace_id"] for r in calls if r["trace_id"]],
            ga_client_id=req.gaClientId,
        )

    # --- export --------------------------------------------------------------------------

    async def _db_user(self, s: Subject) -> dict[str, list[Doc]]:
        uid = s.id
        out: dict[str, list[Doc]] = {}
        user = await self.pool.fetch('select * from "user" where id = $1', uid)
        email = user[0]["email"] if user else ""
        for table, sql, args in [
            ("user", 'select * from "user" where id = $1', [uid]),
            ("account", "select * from account where user_id = $1", [uid]),
            ("session", "select * from session where user_id = $1", [uid]),
            ("member", "select * from member where user_id = $1", [uid]),
            (
                "invitation",
                "select * from invitation where inviter_id = $1 or lower(email) = lower($2)",
                [uid, email],
            ),
            ("two_factor", "select * from two_factor where user_id = $1", [uid]),
            ("passkey", "select * from passkey where user_id = $1", [uid]),
            # Lite Telegram support: which Telegram user and topic (deleted with the user).
            (
                "telegram_support_users",
                "select * from telegram_support_users where user_id = $1",
                [uid],
            ),
            (
                "privacy_requests",
                "select * from privacy_requests where subject_type = 'user' and subject_id = $1",
                [uid],
            ),
        ]:
            out[table] = rows(table, await self.pool.fetch(sql, *args))
        per_org = {
            "audit_log": "select * from audit_log where actor_id = $1",
            "ai_calls": "select * from ai_calls where actor_id = $1",
            "projects": "select * from projects where reviewed_by = $1",
            "attachments": "select * from attachments where created_by = $1",
            "reward_grants": "select * from reward_grants where subject = $1",
        }
        for table, sql in per_org.items():

            async def q(conn: Conn, _: str, sql: str = sql) -> list[asyncpg.Record]:
                return await conn.fetch(sql, uid)

            out[table] = [r for b in await self._each_org(s, q) for r in rows(table, b)]
        return out

    async def _db_org(self, s: Subject) -> dict[str, list[Doc]]:
        oid = s.id
        out: dict[str, list[Doc]] = {}
        for table, sql in [
            ("organization", "select * from organization where id = $1"),
            (
                "member",
                'select m.*, u.name, u.email from member m join "user" u on u.id = m.user_id'
                " where m.organization_id = $1",
            ),
            ("invitation", "select * from invitation where organization_id = $1"),
            ("apikey", "select * from apikey where reference_id = $1"),
            (
                "privacy_requests",
                "select * from privacy_requests where subject_type = 'org' and subject_id = $1",
            ),
        ]:
            out[table] = rows(table, await self.pool.fetch(sql, oid))
        tenant = (
            "projects",
            "attachments",
            "ai_calls",
            "audit_log",
            "webhook_endpoints",
            "webhook_events",
            "webhook_deliveries",
            "webhook_attempts",
            "subscriptions",
            "mcp_servers",
            "usage_counters",
            "reward_grants",
        )

        async def q(conn: Conn, _: str) -> dict[str, list[Doc]]:
            # RLS limits every table to this organization.
            return {t: rows(t, await conn.fetch(f"select * from {t}")) for t in tenant}  # noqa: S608

        out |= (await self._each_org(s, q))[0]
        return out

    @activity.defn(name="privacy_build_export")
    async def build_export(self, req: PrivacyRequest) -> Doc:
        """Gathers everything into one ZIP in S3 and marks the request completed. Idempotent:
        a retry rebuilds and overwrites the same object."""
        attempt = activity.info().attempt
        s = await self.subject(req)
        db = await (self._db_user(s) if s.type == "user" else self._db_org(s))
        files: dict[str, bytes] = {
            f"db/{t}.json": json.dumps(r, indent=2).encode() for t, r in db.items()
        }
        sources: dict[str, Doc] = {"database": outcome("done", "", tables=len(db))}

        stored = 0
        for a in db["attachments"]:
            key = f"{a['org_id']}/{a['project_id']}/{a['id']}"
            try:
                # User-chosen names: no path parts in the ZIP (no "../" on extraction).
                name = re.sub(r"[^\w. -]", "_", str(a["filename"])).lstrip(".")
                files[f"files/attachments/{a['id']}-{name}"] = await self.files.get(key)
                stored += 1
            except NotFound:  # never uploaded (abandoned upload)
                pass
        for c in db["ai_calls"]:
            for key in (c["request_key"], c["response_key"]):
                if not key:
                    continue
                try:
                    files[f"files/ai-content/{key}"] = await self.ai_content.get(key)
                    stored += 1
                except NotFound:  # content past its retention
                    pass
        sources["storage"] = outcome("done", "", objects=stored)

        for tool in self.tools.for_subject(s.type):
            if tool.name in NOT_EXPORTABLE:
                sources[tool.name] = outcome("not_supported", NOT_EXPORTABLE[tool.name])
                continue
            try:
                files[f"tools/{tool.name}.json"] = json.dumps(
                    jsonable(await tool.export(s)), indent=2
                ).encode()
                sources[tool.name] = outcome("done")
            except ApplicationError as err:
                if attempt < EXPORT_ATTEMPTS:
                    raise
                sources[tool.name] = outcome("failed", err.message)
        sources |= STATIC

        now = datetime.now(UTC)
        files["README.md"] = readme(req, sources, now)
        key = f"{EXPORT_PREFIX}{req.requestId}.zip"
        await self.files.put(key, zip_bytes(files), "application/zip")
        await self.pool.execute(
            "update privacy_requests set status = 'completed', result_key = $2, expires_at = $3,"
            " completed_at = $4, report = $5 where id = $1",
            req.requestId,
            key,
            now + self.export_ttl,
            now,
            json.dumps(sources),
        )
        log.info("privacy export %s stored: %d files", req.requestId, len(files))
        return {"key": key, "files": len(files)}

    @activity.defn(name="privacy_mark_failed")
    async def mark_failed(self, req: PrivacyRequest) -> None:
        await self.pool.execute(
            "update privacy_requests set status = 'failed', completed_at = now()"
            " where id = $1 and status in ('scheduled', 'running')",
            req.requestId,
        )

    # --- deletion ------------------------------------------------------------------------

    @activity.defn(name="privacy_begin_deletion")
    async def begin_deletion(self, req: PrivacyRequest) -> bool:
        """False when the request was cancelled in its grace period (the row decides), or when
        the user became the only owner of an organization meanwhile (then it fails, with the
        reason in the report: the organization must be handed over or deleted first)."""
        if req.subjectType == "user" and await self.pool.fetchval(
            "select count(*) from member m where m.user_id = $1 and m.role ~ $2 and not exists"
            " (select 1 from member o where o.organization_id = m.organization_id"
            " and o.user_id <> $1 and o.role ~ $2)",
            req.subjectId,
            OWNER_ROLE,
        ):
            report = {"ownership": outcome("failed", "only owner of an organization")}
            await self.pool.execute(
                "update privacy_requests set status = 'failed', completed_at = now(), report = $2"
                " where id = $1 and status = 'scheduled'",
                req.requestId,
                json.dumps(report),
            )
            return False
        status = await self.pool.fetchval(
            "update privacy_requests set status = 'running'"
            " where id = $1 and status in ('scheduled', 'running') returning status",
            req.requestId,
        )
        return status == "running"

    @activity.defn(name="privacy_deletion_step")
    async def deletion_step(self, step: Step) -> Doc:
        """One step of a deletion; every step is idempotent (safe to retry or resume)."""
        req = step.request
        s = await self.subject(req)
        local: dict[str, Callable[[Subject], Awaitable[Doc]]] = {
            "sessions": self._sessions,
            "access": self._access,
            "webhooks": self._webhooks,
            "billing": self._billing,
            "storage": self._storage,
            "database": self._database,
        }
        if step.name in local:
            return await local[step.name](s)
        tool = next((t for t in self.tools.all if t.name == step.name), None)
        if tool is None:
            return outcome("skipped", "not configured on this deployment")
        return await tool.delete(s)

    async def _sessions(self, s: Subject) -> Doc:
        result: str = await self.pool.execute("delete from session where user_id = $1", s.id)
        return outcome("done", "signed out everywhere", sessions=int(result.split()[-1]))

    async def _access(self, s: Subject) -> Doc:
        keys: str = await self.pool.execute("delete from apikey where reference_id = $1", s.id)
        invites: str = await self.pool.execute(
            "delete from invitation where organization_id = $1", s.id
        )
        await self.pool.execute(
            "update session set active_organization_id = null where active_organization_id = $1",
            s.id,
        )
        return outcome(
            "done",
            "API keys revoked, invitations withdrawn",
            api_keys=int(keys.split()[-1]),
            invitations=int(invites.split()[-1]),
        )

    async def _webhooks(self, s: Subject) -> Doc:
        async def q(conn: Conn, _: str) -> str:
            return await conn.execute(
                "update webhook_endpoints set enabled = false, disabled_reason = 'manual',"
                " disabled_at = now() where enabled"
            )

        result: str = (await self._each_org(s, q))[0]
        return outcome("done", "endpoints disabled", endpoints=int(result.split()[-1]))

    async def _billing(self, s: Subject) -> Doc:
        """The API told the provider to stop renewing when the deletion was requested
        (apps/api/src/routes/privacy.ts `stopRenewal`, BillingProvider.cancel). Here: confirm
        nothing renews any more (e.g. a new subscription during the grace period), then drop our
        row. Invoices and payments stay with the provider (its own legal retention)."""

        async def q(conn: Conn, _: str) -> asyncpg.Record | None:
            return await conn.fetchrow("select status, cancel_at_period_end from subscriptions")

        sub = (await self._each_org(s, q))[0]
        if sub is None:
            return outcome("skipped", "no subscription")
        if sub["status"] in ("active", "past_due") and not sub["cancel_at_period_end"]:
            # ApplicationError, not an outcome: the workflow records it as failed and goes on.
            raise ApplicationError(
                "subscription still renews: cancel it in Billing", non_retryable=True
            )

        async def drop(conn: Conn, _: str) -> str:
            return await conn.execute("delete from subscriptions")

        await self._each_org(s, drop)
        return outcome("done", "renewal stopped with the provider; subscription row deleted")

    async def _storage(self, s: Subject) -> Doc:
        if s.type == "org":
            files = await self.files.list_keys(f"{s.id}/")
            content = await self.ai_content.list_keys(f"{s.id}/")
        else:
            files = []
            calls = await self._ai_calls(s)
            content = [k for c in calls for k in (c["request_key"], c["response_key"]) if k]
        # ponytail: one DELETE per object; switch to DeleteObjects batches for large orgs.
        for key in files:
            await self.files.delete(key)
        for key in content:
            await self.ai_content.delete(key)
        exports = await self.pool.fetch(
            "select id, result_key from privacy_requests"
            " where subject_type = $1 and subject_id = $2 and result_key is not null",
            s.type,
            s.id,
        )
        for e in exports:
            await self.files.delete(e["result_key"])
            await self.pool.execute(
                "update privacy_requests set result_key = null where id = $1", e["id"]
            )
        return outcome(
            "done",
            "uploads, AI request/response content and data exports",
            files=len(files),
            ai_content=len(content),
            exports=len(exports),
        )

    async def _database(self, s: Subject) -> Doc:
        if s.type == "org":
            return await self._database_org(s)
        uid = s.id

        async def anonymise(conn: Conn, _: str) -> int:
            changed = 0
            for sql in (
                "update projects set reviewed_by = null where reviewed_by = $1",
                "update attachments set created_by = null where created_by = $1",
                "update audit_log set ip = null where actor_id = $1 and ip is not null",
            ):
                changed += int((await conn.execute(sql, uid)).split()[-1])
            return changed

        anonymised = sum(await self._each_org(s, anonymise))
        email = await self.pool.fetchval('select email from "user" where id = $1', uid)
        if email:
            await self.pool.execute(
                "delete from invitation where lower(email) = lower($1) and status = 'pending'",
                email,
            )
            await self.pool.execute(
                "delete from verification where identifier = $1 or value like '%' || $2 || '%'",
                email,
                uid,
            )
        # Cascades: sessions, accounts, memberships, 2FA, passkeys, invitations they sent, the
        # Telegram support mapping.
        deleted: str = await self.pool.execute('delete from "user" where id = $1', uid)
        return outcome(
            "done",
            "account deleted; audit_log and ai_calls rows kept (legal record), IP addresses"
            " cleared",
            users=int(deleted.split()[-1]),
            anonymised=anonymised,
        )

    async def _database_org(self, s: Subject) -> Doc:
        async def wipe(conn: Conn, _: str) -> int:
            removed = 0
            for table in (
                "webhook_attempts",
                "webhook_deliveries",
                "webhook_events",
                "webhook_endpoints",
                "mcp_servers",
                "projects",  # attachments cascade
            ):
                removed += int((await conn.execute(f"delete from {table}")).split()[-1])  # noqa: S608
            await conn.execute("update audit_log set ip = null where ip is not null")
            return removed

        removed = (await self._each_org(s, wipe))[0]
        members: str = await self.pool.execute(
            "delete from member where organization_id = $1", s.id
        )
        # The row stays (anonymised) until the retained records expire: ai_calls and audit_log
        # reference it and must be kept for the record-keeping period (docs/privacy.md).
        await self.pool.execute(
            "update organization set name = 'Deleted organization', slug = 'deleted-' || id,"
            " logo = null, metadata = null, require_two_factor = false, suspend_reason = null"
            " where id = $1",
            s.id,
        )
        return outcome(
            "done",
            "data deleted; ai_calls and audit_log kept until the record period ends",
            rows=removed,
            members=int(members.split()[-1]),
        )

    @activity.defn(name="privacy_finish_deletion")
    async def finish_deletion(self, f: Finish) -> None:
        report = {**f.report, **STATIC, **(ORG_STATIC if f.request.subjectType == "org" else {})}
        expires = datetime.now(UTC) + self.org_records if f.request.subjectType == "org" else None
        await self.pool.execute(
            "update privacy_requests set status = 'completed', report = $2, completed_at = now(),"
            " expires_at = $3 where id = $1",
            f.request.requestId,
            json.dumps(report),
            expires,
        )
        failed = [k for k, v in report.items() if v["status"] == "failed"]
        log.info("privacy deletion %s completed; failed steps: %s", f.request.requestId, failed)

    # --- retention -----------------------------------------------------------------------

    @activity.defn(name="privacy_purge_ai_content")
    async def purge_ai_content(self, since: str | None) -> Doc:
        """Deletes the S3 content of AI calls whose content_expires_at passed after `since` (the
        previous run's `until`; None = everything expired so far). The rows stay: they are the
        record and hold no content (ai_calls is append-only)."""
        until = datetime.now(UTC)
        start = datetime.fromisoformat(since) if since else None
        calls = objects = 0
        for org_id in await self._org_ids():

            async def q(conn: Conn) -> list[asyncpg.Record]:
                return await conn.fetch(
                    "select request_key, response_key from ai_calls where content_expires_at <= $1"
                    " and ($2::timestamptz is null or content_expires_at > $2)",
                    until,
                    start,
                )

            for r in await self._in_org(org_id, q):
                calls += 1
                for key in (r["request_key"], r["response_key"]):
                    if key:
                        await self.ai_content.delete(key)
                        objects += 1
        log.info("purged AI content of %d calls (%d objects)", calls, objects)
        return {"until": until.isoformat(), "calls": calls, "objects": objects}

    @activity.defn(name="privacy_purge_exports")
    async def purge_exports(self) -> int:
        """Deletes data export ZIPs past their expires_at."""
        due = await self.pool.fetch(
            "select id, result_key from privacy_requests where kind = 'export'"
            " and result_key is not null and expires_at <= now()"
        )
        for r in due:
            await self.files.delete(r["result_key"])
            await self.pool.execute(
                "update privacy_requests set result_key = null where id = $1", r["id"]
            )
        return len(due)

    @activity.defn(name="privacy_purge_tracker_inbox")
    async def purge_tracker_inbox(self) -> int:
        """Deletes tracker items (redacted alert/feedback text) older than a day that no
        TrackerItemWorkflow removed: a duplicate webhook, or a workflow that gave up."""
        old = await self.files.list_keys(INBOX, before=datetime.now(UTC) - timedelta(days=1))
        for key in old:
            await self.files.delete(key)
        return len(old)

    @activity.defn(name="privacy_purge_booking_payloads")
    async def purge_booking_payloads(self) -> int:
        """Deletes booking webhook payloads (attendee name and email, apps/api/src/routes/crm.ts)
        older than BOOKING_PAYLOAD_DAYS. The CRM sync deletes each one after use; this catches
        the ones whose sync failed for good. The key's day segment is the day it was written."""
        cutoff = (datetime.now(UTC) - timedelta(days=self.booking_days)).date().isoformat()
        old = [k for k in await self.files.list_keys(BOOKING_PREFIX) if k.split("/")[1] < cutoff]
        for key in old:
            await self.files.delete(key)
        return len(old)

    @activity.defn(name="privacy_purge_deleted_orgs")
    async def purge_deleted_orgs(self) -> int:
        """Removes deleted organizations once their record period ended: the anonymised row and,
        by cascade, the ai_calls and audit_log rows kept for it."""
        due = await self.pool.fetch(
            "select r.subject_id from privacy_requests r join organization o on o.id = r.subject_id"
            " where r.kind = 'deletion' and r.subject_type = 'org' and r.status = 'completed'"
            " and r.expires_at <= now()"
        )
        for r in due:
            await self.pool.execute("delete from organization where id = $1", r["subject_id"])
        return len(due)


USER_STEPS = (
    "sessions",
    "posthog",
    "langfuse",
    "chatwoot",
    "ga4",
    "twenty",
    "storage",
    "database",
)
ORG_STEPS = ("access", "webhooks", "billing", "langfuse", "twenty", "storage", "database")
# Our own steps retry until they succeed (or fail for good); a tool that keeps failing is reported.
CORE_STEPS = frozenset({"sessions", "access", "webhooks", "billing", "storage", "database"})
