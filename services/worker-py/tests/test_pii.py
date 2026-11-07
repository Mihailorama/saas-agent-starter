import json
import threading
from collections.abc import Iterator
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

import pytest

from worker import pii

# Structured PII: pattern recognizers with checksums/validation, language independent.
FOUND = [
    ("Upload fails, mail me at a@example.com", "Upload fails, mail me at [email]"),
    ("Call +1 415 555 0132 or (415) 555-0199", "Call [phone] or [phone]"),
    ("Ring +44 20 7946 0958 please", "Ring [phone] please"),
    ("Mobile 07700 900123", "Mobile [phone]"),
    ("My card 4111 1111 1111 1111 was charged twice", "My card [card] was charged twice"),
    ("IBAN DE89 3704 0044 0532 0130 00 for the refund", "IBAN [iban] for the refund"),
    ("IBAN GB82WEST12345698765432", "IBAN [iban]"),
    ("Server 192.168.10.4 and 2001:db8::1 time out", "Server [ip] and [ip] time out"),
    # Names: spaCy's small English model, reliable for full names in English sentences.
    ("John Smith from Acme says the export breaks", "[name] from Acme says the export breaks"),
    ("Ask Maria Garcia or Wei Zhang about it", "Ask [name] or [name] about it"),
    ("Reported by Jean-Luc Picard", "Reported by [name]"),
    ("Dr. Olusegun Obasanjo cannot log in", "Dr. [name] cannot log in"),
]

# Left alone: product words, ids, URLs, invalid card numbers.
KEPT = [
    "Export to CSV fails on the projects page since release 1.4.2",
    "Card 4111-1111-1111-1112 (bad checksum)",
    "Order ID 123456789, trace 4bf92f3577b34da6a3ce929d0e0e4736",
    "Visit https://app.example.com/projects/42 and press Save",
    "Notion import fails for Linear users",
    "Lisbon office cannot reach Paris server",
    "org 0b9c7a3e-5d2f-4c1a-9e8b-7f6a5d4c3b2a on /projects/$projectId",
]

# Known gaps, measured 2026-11-07 with en_core_web_sm 3.8.0 (docs/support.md "Personal data").
# Not strict: an improvement in a model update must not fail the build.
GAPS = [
    ("Ana logged in twice", "[name] logged in twice"),  # short sentence-initial name missed
    ("Phone: 555-0132", "Phone: [phone]"),  # local number without area code
    ("mail john.doe(at)example.com", "mail [email]"),  # obfuscated email
    ("ask john about the invoice", "ask [name] about the invoice"),  # span eats "about"
    ("Customer Priya reports a crash", "Customer [name] reports a crash"),  # eats "Customer"
    # German: the English model tags "Tel" as a name (the name and phone are still caught).
    ("Hans Müller schreibt: Tel. +49 30 901820", "[name] schreibt: Tel. [phone]"),
]


@pytest.mark.parametrize(("text", "want"), FOUND)
def test_redacts(text: str, want: str) -> None:
    assert pii.redact(text) == want


@pytest.mark.parametrize("text", KEPT)
def test_keeps(text: str) -> None:
    assert pii.redact(text) == text


@pytest.mark.xfail(strict=False, reason="known precision gap of the small English model")
@pytest.mark.parametrize(("text", "want"), GAPS)
def test_known_gaps(text: str, want: str) -> None:
    assert pii.redact(text) == want


def test_empty_and_long_input() -> None:
    assert pii.redact("") == ""
    assert pii.redact("   ") == "   "
    assert len(pii.redact("word " * 10_000)) == pii.MAX_CHARS


@pytest.fixture(scope="module")
def server() -> Iterator[int]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), pii._Handler)  # pyright: ignore[reportPrivateUsage]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_port
    httpd.shutdown()


def _call(port: int, method: str, path: str, body: object = None) -> tuple[int, object]:
    conn = HTTPConnection("127.0.0.1", port, timeout=30)
    data = None if body is None else json.dumps(body).encode()
    conn.request(method, path, data, {"content-type": "application/json"})
    res = conn.getresponse()
    return res.status, json.loads(res.read())


def test_http_sidecar(server: int) -> None:
    texts = ["mail a@example.com", "John Smith called", ""]
    assert _call(server, "POST", "/redact", {"texts": texts}) == (
        200,
        {"texts": ["mail [email]", "[name] called", ""]},
    )
    assert _call(server, "GET", "/healthz") == (200, {})
    assert _call(server, "POST", "/redact", {"texts": [1]})[0] == 400
    assert _call(server, "POST", "/redact", {"nope": []})[0] == 400
    assert _call(server, "POST", "/other", {"texts": []})[0] == 400
