"""Email delivery over SMTP (docs/email.md, ADR 0014).

The API renders the message (React Email) and starts SendEmailWorkflow; this activity only
delivers it. Temporal retries failed attempts. Logs and errors carry the kind and workflow id,
never the address, the link or the SMTP server's reply (it can echo the address).
"""

import asyncio
import logging
import smtplib
import ssl
from dataclasses import dataclass, field
from email import policy
from email.message import EmailMessage
from email.utils import make_msgid
from urllib.parse import parse_qs, unquote, urlsplit

from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker import settings

log = logging.getLogger("worker.mail")


@dataclass(frozen=True)
class SendEmail:
    """Workflow input. Contract with `SendEmail` in apps/api/src/temporal.ts."""

    kind: str
    to: str
    subject: str
    html: str
    text: str
    # Marketing mail: List-Unsubscribe and List-Unsubscribe-Post (RFC 8058, docs/legal.md).
    headers: dict[str, str] = field(default_factory=dict[str, str])


# The only extra headers the API may set; anything else is dropped.
EXTRA_HEADERS = ("List-Unsubscribe", "List-Unsubscribe-Post")


@dataclass(frozen=True)
class Smtp:
    host: str
    port: int
    tls: str  # "implicit" (smtps://), "starttls" (smtp://, required) or "none" (?tls=none)
    username: str
    password: str


def parse_smtp_url(url: str) -> Smtp:
    """`smtps://user:pass@host:465`, `smtp://user:pass@host:587` (STARTTLS required), or
    `smtp://host:1025?tls=none` for a local catcher such as Mailpit."""
    parts = urlsplit(url)
    if parts.scheme not in ("smtp", "smtps") or not parts.hostname:
        raise ValueError("SMTP_URL must look like smtp://host:587 or smtps://host:465")
    tls = "implicit" if parts.scheme == "smtps" else "starttls"
    if parse_qs(parts.query).get("tls") == ["none"]:
        tls = "none"
    return Smtp(
        host=parts.hostname,
        port=parts.port or (465 if tls == "implicit" else 587),
        tls=tls,
        username=unquote(parts.username or ""),
        password=unquote(parts.password or ""),
    )


# Long unbreakable header values (a List-Unsubscribe URL) must stay on one line: the default
# 78-character policy would turn them into RFC 2047 encoded words that mail clients do not parse.
# 998 is RFC 5322's hard line limit.
POLICY = policy.default.clone(max_line_length=998)


def build_message(email: SendEmail, sender: str) -> EmailMessage:
    msg = EmailMessage(policy=POLICY)
    msg["From"] = sender
    msg["To"] = email.to
    msg["Subject"] = email.subject
    msg["Message-ID"] = make_msgid(domain=sender.rpartition("@")[2].strip("> ") or None)
    for name in EXTRA_HEADERS:
        value = email.headers.get(name, "")
        if value and "\r" not in value and "\n" not in value:
            msg[name] = value
    msg.set_content(email.text)
    msg.add_alternative(email.html, subtype="html")
    return msg


def deliver(smtp: Smtp, msg: EmailMessage) -> None:
    context = ssl.create_default_context()
    if smtp.tls == "implicit":
        client: smtplib.SMTP = smtplib.SMTP_SSL(smtp.host, smtp.port, timeout=20, context=context)
    else:
        client = smtplib.SMTP(smtp.host, smtp.port, timeout=20)
    with client:
        if smtp.tls == "starttls":
            client.starttls(context=context)  # raises if the server does not offer it
        if smtp.username:
            client.login(smtp.username, smtp.password)
        client.send_message(msg)


@activity.defn(name="send_email")
async def send_email(email: SendEmail) -> str:
    """One delivery attempt. Returns the Message-ID. A retry after a lost reply can send twice."""
    info = activity.info()
    if not settings.SMTP_URL or not settings.MAIL_FROM:
        raise ApplicationError("SMTP_URL and MAIL_FROM must be set", non_retryable=True)
    msg = build_message(email, settings.MAIL_FROM)
    try:
        await asyncio.to_thread(deliver, parse_smtp_url(settings.SMTP_URL), msg)
    except smtplib.SMTPRecipientsRefused:
        # Permanent for this address (unknown mailbox, policy): retrying will not help.
        log.warning("email rejected: kind=%s workflow=%s", email.kind, info.workflow_id)
        raise ApplicationError(
            "recipient refused", type="RecipientRefused", non_retryable=True
        ) from None
    except (smtplib.SMTPException, OSError) as err:
        code = getattr(err, "smtp_code", None)
        log.warning(
            "email attempt failed: kind=%s workflow=%s attempt=%d error=%s code=%s",
            email.kind,
            info.workflow_id,
            info.attempt,
            type(err).__name__,
            code,
        )
        # `from None`: the original message can contain the address; keep only class + code.
        raise ApplicationError(f"SMTP {type(err).__name__} {code or ''}".strip()) from None
    log.info(
        "email sent: kind=%s workflow=%s attempt=%d", email.kind, info.workflow_id, info.attempt
    )
    return str(msg["Message-ID"])
