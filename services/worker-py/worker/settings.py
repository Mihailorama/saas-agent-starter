"""Environment config. Precedence: real env > repo .env > .env.example (as in the TS apps)."""

import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]


def _load_env_files() -> None:
    for name in (".env", ".env.example"):  # earlier file wins; real env always wins
        path = _ROOT / name
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and not key.startswith("#"):
                os.environ.setdefault(key, value)


_load_env_files()

DATABASE_URL = os.environ["DATABASE_URL"]
TEMPORAL_ADDRESS = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
TEMPORAL_NAMESPACE = os.environ.get("TEMPORAL_NAMESPACE", "default")
TEMPORAL_TASK_QUEUE = os.environ.get("TEMPORAL_TASK_QUEUE", "projects")
OTEL_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "")
# Error tracking (Sentry protocol: Sentry or GlitchTip). Empty DSN = off.
SENTRY_DSN = os.environ.get("SENTRY_DSN", "")
SENTRY_ENVIRONMENT = os.environ.get("SENTRY_ENVIRONMENT", "development")
SENTRY_RELEASE = os.environ.get("SENTRY_RELEASE", "")

# Object storage (any S3-compatible endpoint; empty = AWS S3 in S3_REGION).
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID", "")
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "")

# AI layer (docs/adr/0008-ai-layer.md). Empty AI_CONTOUR disables all LLM calls.
AI_CONTOUR = os.environ.get("AI_CONTOUR", "")
AI_MODELS_FILE = Path(os.environ.get("AI_MODELS_FILE", _ROOT / "config" / "ai-models.json"))
AI_CONTENT_BUCKET = os.environ.get("AI_CONTENT_BUCKET", "ai-calls")
# Recorded per call as content_expires_at; enforce it with a lifecycle rule on the bucket.
AI_CONTENT_RETENTION_DAYS = int(os.environ.get("AI_CONTENT_RETENTION_DAYS", "180"))
# Model for the project summary. No default on purpose: unset = feature off.
AI_PROJECT_SUMMARY_PROVIDER = os.environ.get("AI_PROJECT_SUMMARY_PROVIDER", "")
AI_PROJECT_SUMMARY_MODEL = os.environ.get("AI_PROJECT_SUMMARY_MODEL", "")
# Provider credentials: ANTHROPIC_API_KEY and OPENAI_API_KEY are read by the SDKs.
# OpenAI-compatible endpoint (vLLM, in-country providers...); empty = api.openai.com.
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "")

# Outbound webhooks (worker/webhooks.py). Non-global addresses (private, loopback, link-local...)
# are refused; list CIDRs here to allow some anyway (e.g. an on-prem receiver). Dev/tests only
# for 127.0.0.0/8.
WEBHOOK_ALLOWED_CIDRS = [
    c.strip() for c in os.environ.get("WEBHOOK_ALLOWED_CIDRS", "").split(",") if c.strip()
]
WEBHOOK_MAX_PAYLOAD_BYTES = int(os.environ.get("WEBHOOK_MAX_PAYLOAD_BYTES", "65536"))
# Same value as the API's: `id:secret,...`, first one active (worker.webhooks.parse_keys).
WEBHOOK_ENCRYPTION_KEYS = os.environ.get("WEBHOOK_ENCRYPTION_KEYS", "")
# Disable an endpoint after this many failed deliveries in a row (0 = never); 410 disables at once.
WEBHOOK_DISABLE_AFTER_FAILURES = int(os.environ.get("WEBHOOK_DISABLE_AFTER_FAILURES", "5"))
# Daily schedule deletes webhook events and attempts older than this (0 = keep forever).
WEBHOOK_RETENTION_DAYS = int(os.environ.get("WEBHOOK_RETENTION_DAYS", "30"))
