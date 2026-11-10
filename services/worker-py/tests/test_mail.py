"""SMTP delivery: URL parsing, and end to end through Temporal into the compose Mailpit."""

import asyncio
import os
import uuid

import httpx2
import pytest
from temporalio.client import Client
from temporalio.worker import Worker

from worker import settings
from worker.mail import SendEmail, Smtp, build_message, parse_smtp_url, send_email
from worker.workflows import SendEmailWorkflow

MAILPIT_URL = os.environ.get("MAILPIT_URL", "http://localhost:8025")


def test_smtp_url_schemes() -> None:
    assert parse_smtp_url("smtps://u%40x:p%2Fw@mail.example.com") == Smtp(
        "mail.example.com", 465, "implicit", "u@x", "p/w"
    )
    assert parse_smtp_url("smtp://mail.example.com").tls == "starttls"  # TLS unless opted out
    assert parse_smtp_url("smtp://mail.example.com").port == 587
    assert parse_smtp_url("smtp://mailpit:1025?tls=none") == Smtp("mailpit", 1025, "none", "", "")
    with pytest.raises(ValueError):
        parse_smtp_url("http://mail.example.com")


def test_only_unsubscribe_headers_pass() -> None:
    token = "u1." + "x" * 43  # as long as a real token
    url = f"<https://app.example.com/api/unsubscribe?token={token}>"
    headers = {
        "List-Unsubscribe": url,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "Bcc": "someone@example.com",  # not ours to set
    }
    msg = build_message(
        SendEmail("product-update", "a@example.com", "S", "<p>x</p>", "x", headers), "n@example.com"
    )
    assert msg["List-Unsubscribe"] == url
    assert f"List-Unsubscribe: {url}\n" in msg.as_string()  # one line, not RFC 2047 words
    assert msg["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    assert msg["Bcc"] is None
    plain = build_message(
        SendEmail("invitation", "a@example.com", "S", "<p>x</p>", "x"), "n@example.com"
    )
    assert plain["List-Unsubscribe"] is None


async def test_workflow_delivers_html_and_text() -> None:
    to = f"{uuid.uuid4()}@example.com"
    queue = f"test-mail-{uuid.uuid4()}"
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    email = SendEmail(kind="verify-email", to=to, subject="Hi", html="<p>Hello</p>", text="Hello")
    async with Worker(
        client, task_queue=queue, workflows=[SendEmailWorkflow], activities=[send_email]
    ):
        message_id = await client.execute_workflow(
            SendEmailWorkflow.run, email, id=f"test-{uuid.uuid4()}", task_queue=queue
        )
    assert message_id.startswith("<")

    async with httpx2.AsyncClient(base_url=MAILPIT_URL) as http:
        found: list[dict[str, str]] = []
        for _ in range(50):
            search = await http.get("/api/v1/search", params={"query": f"to:{to}"})
            found = search.json()["messages"]
            if found:
                break
            await asyncio.sleep(0.1)
        assert found, f"no mail in Mailpit at {MAILPIT_URL}"
        message = (await http.get(f"/api/v1/message/{found[0]['ID']}")).json()
    assert message["Subject"] == "Hi"
    assert message["Text"].strip() == "Hello"
    assert "<p>Hello</p>" in message["HTML"]
    assert message["MessageID"] in message_id
