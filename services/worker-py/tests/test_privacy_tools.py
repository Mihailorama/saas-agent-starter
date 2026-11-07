"""Privacy adapters of the external tools against canned HTTP (httpx2.MockTransport): the exact
requests each documented API gets, and how failures are reported. No network, no services."""

import base64
import json
from collections.abc import Callable
from typing import Any

import httpx2
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from worker.privacy import (
    ChatwootContacts,
    Ga4UserDeletion,
    Langfuse,
    PostHogPersons,
    Subject,
    ToolError,
)

USER = Subject("user", "user-1", trace_ids=["t1", "t2"], ga_client_id="123.456")
Seen = list[httpx2.Request]


def client(handler: Callable[[httpx2.Request], httpx2.Response]) -> tuple[httpx2.AsyncClient, Seen]:
    seen: Seen = []

    def record(req: httpx2.Request) -> httpx2.Response:
        seen.append(req)
        return handler(req)

    return httpx2.AsyncClient(transport=httpx2.MockTransport(record)), seen


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def body(req: httpx2.Request) -> Any:
    return json.loads(req.content) if req.content else None


async def test_posthog_export_and_delete() -> None:
    def handle(req: httpx2.Request) -> httpx2.Response:
        if req.url.path == "/api/projects/9/persons/":
            persons = [{"id": "uuid-1", "distinct_ids": ["user-1"]}]
            return httpx2.Response(200, json={"results": persons})
        if req.url.path == "/api/projects/9/query/":
            return httpx2.Response(200, json={"columns": ["event"], "results": [["$pageview"]]})
        return httpx2.Response(202, json={"persons_queued_for_deletion": ["uuid-1"]})

    http, seen = client(handle)
    ph = PostHogPersons("https://eu.posthog.com/", "9", "phx_key", http)
    out = await ph.export(USER)
    assert out["persons"][0]["id"] == "uuid-1" and out["events"]["rows"] == [["$pageview"]]
    assert seen[0].url.params["distinct_id"] == "user-1"
    assert seen[0].headers["authorization"] == "Bearer phx_key"
    q = body(seen[1])["query"]
    # The id is a HogQL placeholder value, never spliced into the query text.
    assert q["kind"] == "HogQLQuery" and "user-1" not in q["query"]
    assert q["values"] == {"distinct_id": "user-1"}

    seen.clear()
    result = await ph.delete(USER)
    assert result["status"] == "done" and result["counts"] == {"persons": 1}
    assert [(r.method, r.url.path) for r in seen] == [
        ("POST", "/api/projects/9/persons/bulk_delete/")
    ]
    assert body(seen[0]) == {
        "distinct_ids": ["user-1"],
        "delete_events": True,
        "delete_recordings": True,
    }


async def test_posthog_deletion_errors_fail_the_step() -> None:
    http, _ = client(lambda _: httpx2.Response(202, json={"deletion_errors": [{"x": 1}]}))
    with pytest.raises(ToolError, match="posthog deletion_errors"):
        await PostHogPersons("https://eu.posthog.com", "9", "k", http).delete(USER)


async def test_langfuse_traces_by_ai_call_and_user_id() -> None:
    def handle(req: httpx2.Request) -> httpx2.Response:
        params = req.url.params
        if req.url.path == "/api/public/v2/observations" and "userId" in params:
            # Two pages: the cursor is followed until it is absent.
            if "cursor" not in params:
                return httpx2.Response(
                    200, json={"data": [{"traceId": "t3"}], "meta": {"cursor": "c"}}
                )
            return httpx2.Response(200, json={"data": [{"traceId": "t1"}], "meta": {}})
        if req.url.path == "/api/public/v2/observations":
            return httpx2.Response(
                200, json={"data": [{"id": f"o-{params['traceId']}"}], "meta": {}}
            )
        if req.url.path == "/api/public/v3/scores":
            return httpx2.Response(200, json={"data": [{"name": "user_feedback"}], "meta": {}})
        return httpx2.Response(200, json={"message": "ok"})

    http, seen = client(handle)
    lf = Langfuse("https://cloud.langfuse.com", "pk-lf", "sk-lf", http)
    out = await lf.export(USER)
    assert out["traceIds"] == ["t1", "t2", "t3"]
    assert [o["id"] for o in out["observations"]] == ["o-t1", "o-t2", "o-t3"]
    assert out["scores"] == [{"name": "user_feedback"}]
    expected = "Basic " + base64.b64encode(b"pk-lf:sk-lf").decode()
    assert seen[0].headers["authorization"] == expected
    assert seen[0].url.params["userId"] == "user-1"
    assert seen[-1].url.params["traceId"] == "t1,t2,t3"

    seen.clear()
    result = await lf.delete(USER)
    assert result["counts"] == {"traces": 3}
    assert seen[-1].method == "DELETE" and seen[-1].url.path == "/api/public/traces"
    assert body(seen[-1]) == {"traceIds": ["t1", "t2", "t3"]}


async def test_langfuse_org_uses_only_its_trace_ids() -> None:
    http, seen = client(lambda _: httpx2.Response(200, json={}))
    await Langfuse("https://lf.example.com", "pk", "sk", http).delete(Subject("org", "o", ["a"]))
    assert [(r.method, r.url.path) for r in seen] == [("DELETE", "/api/public/traces")]


async def test_chatwoot_matches_identifier_exactly_and_deletes() -> None:
    def handle(req: httpx2.Request) -> httpx2.Response:
        path = req.url.path
        if path.endswith("/contacts/search"):
            contacts = [{"id": 7, "identifier": "user-1"}, {"id": 8, "identifier": "user-10"}]
            return httpx2.Response(200, json={"payload": contacts})
        if path.endswith("/contacts/7/conversations"):
            return httpx2.Response(200, json={"payload": [{"id": 70}]})
        if path.endswith("/conversations/70/messages"):
            return httpx2.Response(200, json={"payload": [{"content": "hi"}]})
        return httpx2.Response(200, json={})

    http, seen = client(handle)
    cw = ChatwootContacts("https://desk.example.com", "3", "local-dev-token", http)
    out = await cw.export(USER)
    assert [c["id"] for c in out["contacts"]] == [7]
    assert out["contacts"][0]["conversations"][0]["messages"] == [{"content": "hi"}]
    assert seen[0].headers["api_access_token"] == "local-dev-token"  # noqa: S105
    assert seen[0].url.params["q"] == "user-1"

    seen.clear()
    result = await cw.delete(USER)
    assert result["counts"] == {"contacts": 1}
    # Conversations and messages are deleted by Chatwoot with the contact.
    deletes = [r.url.path for r in seen if r.method == "DELETE"]
    assert deletes == ["/api/v1/accounts/3/contacts/7"]


async def test_chatwoot_online_contact_is_retried_later() -> None:
    def handle(req: httpx2.Request) -> httpx2.Response:
        if req.method == "DELETE":
            return httpx2.Response(422, json={"message": "online"})
        return httpx2.Response(200, json={"payload": [{"id": 7, "identifier": "user-1"}]})

    http, _ = client(handle)
    with pytest.raises(ToolError) as err:
        await ChatwootContacts("https://desk.example.com", "3", "t", http).delete(USER)
    assert err.value.message == "chatwoot HTTP 422" and not err.value.non_retryable


async def test_ga4_user_deletion_with_service_account() -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    sa = {"client_email": "sa@example.iam.gserviceaccount.com", "private_key": pem}

    def handle(req: httpx2.Request) -> httpx2.Response:
        if req.url.host == "oauth2.googleapis.com":
            return httpx2.Response(200, json={"access_token": "ya29.test", "expires_in": 3600})
        return httpx2.Response(200, json={"deletionRequestTime": "2026-11-07T00:00:00Z"})

    http, seen = client(handle)
    result = await Ga4UserDeletion("123456", sa, http).delete(USER)
    assert result["status"] == "done"
    form = dict(x.split("=", 1) for x in seen[0].content.decode().split("&"))
    assert form["grant_type"] == "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"
    header, claims, sig = form["assertion"].split(".")
    assert json.loads(unb64(claims))["scope"] == Ga4UserDeletion.SCOPE
    key.public_key().verify(
        unb64(sig), f"{header}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256()
    )
    deletion = seen[1]
    assert deletion.url.host == "analyticsadmin.googleapis.com"
    assert deletion.url.path == "/v1alpha/properties/123456:submitUserDeletion"
    assert deletion.headers["authorization"] == "Bearer ya29.test"
    assert body(deletion) == {"clientId": "123.456"}


async def test_ga4_without_client_id_is_skipped() -> None:
    http, seen = client(lambda _: httpx2.Response(500))
    result = await Ga4UserDeletion("1", {}, http).delete(Subject("user", "u"))
    assert result["status"] == "skipped" and seen == []


@pytest.mark.parametrize(("status", "retryable"), [(403, False), (429, True), (503, True)])
async def test_errors_name_tool_and_status_only(status: int, retryable: bool) -> None:
    http, _ = client(lambda _: httpx2.Response(status, json={"detail": "user-1 secret"}))
    with pytest.raises(ToolError) as err:
        await PostHogPersons("https://eu.posthog.com", "9", "k", http).delete(USER)
    assert err.value.message == f"posthog HTTP {status}"
    assert err.value.non_retryable is not retryable
