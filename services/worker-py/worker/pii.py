"""PII redaction with Microsoft Presidio (docs/support.md "Personal data"), in process.

`redact(text)` replaces emails, phone numbers, card numbers, IBANs, IP addresses and person names
with `[email]`, `[phone]`, ... Pattern recognizers (with checksums for cards and IBANs) find the
first five in any language; names come from spaCy's small English model (`en_core_web_sm`), so
they are found in English text only, and not every name is (see the tests for known gaps).
The engines load on first use (2-15 s, ~100-190 MiB, docs/STACK.md); `warm_up()` does it at start.
Also served over HTTP to the API by `python -m worker.pii` (compose profile `pii`).
"""

import json
import logging
import os
import re
import tempfile
import threading
from functools import cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

log = logging.getLogger(__name__)

# tldextract (used by Presidio's email check) would download the public suffix list on import;
# its bundled snapshot is enough to tell a domain from a word. The image's user has no home.
os.environ.setdefault("TLDEXTRACT_PUBLIC_SUFFIX_LIST_URLS", "")
os.environ.setdefault("TLDEXTRACT_CACHE", os.path.join(tempfile.gettempdir(), "tldextract"))

LANGUAGE = "en"
MODEL = "en_core_web_sm"
REPLACEMENTS = {
    "EMAIL_ADDRESS": "[email]",
    "PHONE_NUMBER": "[phone]",
    "CREDIT_CARD": "[card]",
    "IBAN_CODE": "[iban]",
    "IP_ADDRESS": "[ip]",
    "PERSON": "[name]",
}
NOT_PII_LABELS = [
    *("CARDINAL", "DATE", "EVENT", "FAC", "GPE", "LANGUAGE", "LAW", "LOC", "MONEY"),
    *("NORP", "ORDINAL", "ORG", "PERCENT", "PRODUCT", "QUANTITY", "TIME", "WORK_OF_ART"),
]
# Presidio's email recognizer misses addresses inside paths/query strings and some TLDs
# (`/invite/bob@acme.io`, `a+x@corp.internal`); this bounded pattern runs after it, as before.
EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+")
MAX_CHARS = 20_000  # per text; longer input is cut before analysis


@cache
def _engines() -> tuple[Any, Any, dict[str, Any]]:
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider
    from presidio_anonymizer import AnonymizerEngine
    from presidio_anonymizer.entities import OperatorConfig

    # Loading logs one warning per recognizer of a language we do not load (es, it, pl...).
    logging.getLogger("presidio-analyzer").setLevel(logging.ERROR)
    nlp = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": LANGUAGE, "model_name": MODEL}],
            # spaCy's other entity types (ORG, DATE, CARDINAL...) are not personal data here.
            "ner_model_configuration": {"labels_to_ignore": NOT_PII_LABELS},
        }
    ).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=[LANGUAGE])
    logging.getLogger("presidio-analyzer").setLevel(logging.NOTSET)
    operators = {k: OperatorConfig("replace", {"new_value": v}) for k, v in REPLACEMENTS.items()}
    return analyzer, AnonymizerEngine(), operators


_lock = threading.Lock()  # spaCy pipelines are not documented as thread-safe


def redact(text: str) -> str:
    text = text[:MAX_CHARS]
    if not text.strip():
        return text
    analyzer, anonymizer, operators = _engines()
    with _lock:
        found = analyzer.analyze(text=text, language=LANGUAGE, entities=list(REPLACEMENTS))
        out = anonymizer.anonymize(text=text, analyzer_results=found, operators=operators).text
    return EMAIL.sub(REPLACEMENTS["EMAIL_ADDRESS"], out)


def warm_up() -> None:
    redact("warm up")


class _Handler(BaseHTTPRequestHandler):
    """POST /redact {"texts": [...]} -> {"texts": [...]}; GET /healthz once the model is loaded."""

    def do_GET(self) -> None:
        self._send(200 if self.path == "/healthz" else 404, {})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        if length > 1_000_000:
            self._send(413, {"error": "body over 1 MB"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            texts = body["texts"]
            if self.path != "/redact" or not all(isinstance(t, str) for t in texts):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            self._send(400, {"error": "expected POST /redact {texts: [string]}"})
            return
        self._send(200, {"texts": [redact(t) for t in texts]})

    def _send(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # access logs could only repeat what the caller already knows; never the text


def serve(port: int) -> None:
    warm_up()
    server = ThreadingHTTPServer(("0.0.0.0", port), _Handler)  # noqa: S104 (container network)
    log.info("pii redaction listening on :%d (model %s)", port, MODEL)
    server.serve_forever()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    serve(int(os.environ.get("PII_PORT", "8000")))
