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
EMAIL_TASK_QUEUE = os.environ.get("EMAIL_TASK_QUEUE", "email")
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
PROMPTS_DIR = Path(os.environ.get("PROMPTS_DIR", _ROOT / "prompts"))
AI_CONTENT_BUCKET = os.environ.get("AI_CONTENT_BUCKET", "ai-calls")
# Recorded per call as content_expires_at; enforce it with a lifecycle rule on the bucket.
AI_CONTENT_RETENTION_DAYS = int(os.environ.get("AI_CONTENT_RETENTION_DAYS", "180"))
# Model for the project summary. No default on purpose: unset = feature off.
AI_PROJECT_SUMMARY_PROVIDER = os.environ.get("AI_PROJECT_SUMMARY_PROVIDER", "")
AI_PROJECT_SUMMARY_MODEL = os.environ.get("AI_PROJECT_SUMMARY_MODEL", "")
# Provider credentials: ANTHROPIC_API_KEY and OPENAI_API_KEY are read by the SDKs.
# OpenAI-compatible endpoint (vLLM, in-country providers...); empty = api.openai.com.
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "")

# Traces only (e.g. Langfuse's OTLP endpoint, which takes no metrics); overrides the base URL.
OTEL_TRACES_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
# LLM observability in PostHog (docs/adr/0009-llm-ops.md): each call as an $ai_generation event.
# Uses POSTHOG_KEY / POSTHOG_HOST (defined with the feature flags below).
# Unset = nothing is sent. Privacy mode (default on) leaves prompt and output text out.
POSTHOG_PRIVACY_MODE = os.environ.get("POSTHOG_PRIVACY_MODE", "true").lower() != "false"
# Transactional email (docs/email.md): smtps://user:pass@host:465, smtp://user:pass@host:587
# (STARTTLS required) or smtp://host:1025?tls=none (local Mailpit). Empty = sending fails.
SMTP_URL = os.environ.get("SMTP_URL", "")
MAIL_FROM = os.environ.get("MAIL_FROM", "")

# Feature flags (docs/feature-flags.md). PostHog decides when POSTHOG_KEY is set; FLAGS_ON /
# FLAGS_OFF (comma-separated names) override it and the catalog default in config/flags.json.
FLAGS_FILE = Path(os.environ.get("FLAGS_FILE", _ROOT / "config" / "flags.json"))
FLAGS_ON = frozenset(f.strip() for f in os.environ.get("FLAGS_ON", "").split(",") if f.strip())
FLAGS_OFF = frozenset(f.strip() for f in os.environ.get("FLAGS_OFF", "").split(",") if f.strip())
POSTHOG_KEY = os.environ.get("POSTHOG_KEY", "")
POSTHOG_HOST = os.environ.get("POSTHOG_HOST", "")

# Billing (docs/billing.md): plans and limits, shared with the API.
PLANS_FILE = Path(os.environ.get("PLANS_FILE", _ROOT / "config" / "plans.json"))
