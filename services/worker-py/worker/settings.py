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

# Bucket of uploads (attachments) and data exports; same value as the API's S3_BUCKET.
S3_BUCKET = os.environ.get("S3_BUCKET", "attachments")

# AI layer (docs/adr/0008-ai-layer.md). Empty AI_CONTOUR disables all LLM calls.
AI_CONTOUR = os.environ.get("AI_CONTOUR", "")
AI_MODELS_FILE = Path(os.environ.get("AI_MODELS_FILE", _ROOT / "config" / "ai-models.json"))
PROMPTS_DIR = Path(os.environ.get("PROMPTS_DIR", _ROOT / "prompts"))
AI_CONTENT_BUCKET = os.environ.get("AI_CONTENT_BUCKET", "ai-calls")
# Recorded per call as content_expires_at; the daily privacy-retention schedule deletes the content.
AI_CONTENT_RETENTION_DAYS = int(os.environ.get("AI_CONTENT_RETENTION_DAYS", "180"))
# Model for the project summary. No default on purpose: unset = feature off.
AI_PROJECT_SUMMARY_PROVIDER = os.environ.get("AI_PROJECT_SUMMARY_PROVIDER", "")
AI_PROJECT_SUMMARY_MODEL = os.environ.get("AI_PROJECT_SUMMARY_MODEL", "")
# Providers (docs/llm-providers.md): `providers` in AI_MODELS_FILE names the env variables with
# each provider's key and base URL (ANTHROPIC_API_KEY, VLLM_BASE_URL, ...); read at startup.
# CLI subscriptions: the llm-cli container (services/llm-cli) and its bearer token.
LLM_CLI_URL = os.environ.get("LLM_CLI_URL", "")
LLM_CLI_TOKEN = os.environ.get("LLM_CLI_TOKEN", "")
AI_REQUEST_TIMEOUT_SECONDS = float(os.environ.get("AI_REQUEST_TIMEOUT_SECONDS", "120"))
# A CLI run includes the CLI's start-up and the llm-cli queue; keep it above LLM_CLI_TIMEOUT_MS.
AI_CLI_TIMEOUT_SECONDS = float(os.environ.get("AI_CLI_TIMEOUT_SECONDS", "330"))
# Organization-owned providers (ai_providers): custom base URLs in non-global ranges are refused
# like webhook targets; list CIDRs to allow some anyway (an on-prem model server).
AI_BYO_ALLOWED_CIDRS = [
    c.strip() for c in os.environ.get("AI_BYO_ALLOWED_CIDRS", "").split(",") if c.strip()
]

# Outbound webhooks (worker/webhooks.py). Non-global addresses (private, loopback, link-local...)
# are refused; list CIDRs here to allow some anyway (e.g. an on-prem receiver). Dev/tests only
# for 127.0.0.0/8.
WEBHOOK_ALLOWED_CIDRS = [
    c.strip() for c in os.environ.get("WEBHOOK_ALLOWED_CIDRS", "").split(",") if c.strip()
]
WEBHOOK_MAX_PAYLOAD_BYTES = int(os.environ.get("WEBHOOK_MAX_PAYLOAD_BYTES", "65536"))
# Same value as the API's: `id:secret,...`, first one active (worker.webhooks.parse_keys). Also
# encrypts the API keys of organization-owned AI providers.
WEBHOOK_ENCRYPTION_KEYS = os.environ.get("WEBHOOK_ENCRYPTION_KEYS", "")
# Disable an endpoint after this many failed deliveries in a row (0 = never); 410 disables at once.
WEBHOOK_DISABLE_AFTER_FAILURES = int(os.environ.get("WEBHOOK_DISABLE_AFTER_FAILURES", "5"))
# Daily schedule deletes webhook events and attempts older than this (0 = keep forever).
WEBHOOK_RETENTION_DAYS = int(os.environ.get("WEBHOOK_RETENTION_DAYS", "30"))

# Service desk (docs/support.md). Chatwoot holds the tickets, the tracker holds the backlog items;
# every token empty = that side only logs what it would do (dry run).
CHATWOOT_URL = os.environ.get("CHATWOOT_URL", "")  # how the worker reaches Chatwoot
CHATWOOT_PUBLIC_URL = os.environ.get("CHATWOOT_PUBLIC_URL", "") or CHATWOOT_URL  # links for humans
CHATWOOT_API_TOKEN = os.environ.get("CHATWOOT_API_TOKEN", "")  # agent bot or agent access token
# Tracker (worker/tracker.py, the only tracker client): plane (default) | github.
TRACKER = os.environ.get("TRACKER", "plane")
TRACKER_FILE = Path(os.environ.get("TRACKER_FILE", _ROOT / "config" / "tracker.json"))
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
# GitHub Enterprise Server API base (GitHub Actions sets it); empty = https://api.github.com.
GITHUB_API_URL = os.environ.get("GITHUB_API_URL", "")
PLANE_API_URL = os.environ.get("PLANE_API_URL", "")  # e.g. https://api.plane.so
PLANE_APP_URL = os.environ.get("PLANE_APP_URL", "") or PLANE_API_URL  # links for humans
PLANE_WORKSPACE = os.environ.get("PLANE_WORKSPACE", "")
PLANE_PROJECT_ID = os.environ.get("PLANE_PROJECT_ID", "")
PLANE_API_TOKEN = os.environ.get("PLANE_API_TOKEN", "")  # also the author of release comments
# Model for triage. No default on purpose: unset = triage off. Its AI calls are audited under
# SUPPORT_AI_ORG_ID, the operator's own organization (support data is not a tenant's data).
AI_SUPPORT_TRIAGE_PROVIDER = os.environ.get("AI_SUPPORT_TRIAGE_PROVIDER", "")
AI_SUPPORT_TRIAGE_MODEL = os.environ.get("AI_SUPPORT_TRIAGE_MODEL", "")
SUPPORT_AI_ORG_ID = os.environ.get("SUPPORT_AI_ORG_ID", "")
# Also tell the customer when their linked issue is resolved: "true" on close, "release" on the
# "Released in vX.Y.Z" comment (docs/releases.md); anything else = private notes only.
_notify = os.environ.get("SUPPORT_NOTIFY_ON_CLOSE", "false").lower()
SUPPORT_NOTIFY = {"true": "close", "release": "release"}.get(_notify, "")
# CRM sync (docs/crm.md): Twenty's REST API; URL or key empty = dry run (logs only).
TWENTY_API_URL = os.environ.get("TWENTY_API_URL", "")  # with --profile crm: http://twenty:3000
TWENTY_API_KEY = os.environ.get("TWENTY_API_KEY", "")
CRM_FILE = Path(os.environ.get("CRM_FILE", _ROOT / "config" / "crm.json"))
# Links to bookings in CRM notes: your self-hosted Cal.diy (or https://app.cal.com); empty = none.
BOOKING_PUBLIC_URL = os.environ.get("BOOKING_PUBLIC_URL", "")
# Booking payloads left in S3 (a sync that failed for good) are deleted after this many days.
BOOKING_PAYLOAD_DAYS = int(os.environ.get("BOOKING_PAYLOAD_DAYS", "7"))
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
# Optional project secret key (feature_flag:read): local flag evaluation, as in the API.
POSTHOG_SECRET_KEY = os.environ.get("POSTHOG_SECRET_KEY", "")

# Data-subject rights (docs/privacy.md). Export ZIPs are deleted after PRIVACY_EXPORT_TTL_DAYS; a
# deleted organization's ai_calls and audit_log rows are kept PRIVACY_ORG_RECORDS_DAYS (EU AI Act
# Art. 26(6): at least six months) and then purged with the anonymised organization row.
PRIVACY_EXPORT_TTL_DAYS = int(os.environ.get("PRIVACY_EXPORT_TTL_DAYS", "7"))
PRIVACY_ORG_RECORDS_DAYS = int(os.environ.get("PRIVACY_ORG_RECORDS_DAYS", "180"))
# Per-person export/deletion in the external tools; each one is skipped while its settings are
# empty. PostHog: private API host (e.g. https://eu.posthog.com), project id and a personal API key
# with person:read, person:write and query:read (the same variables `pnpm journeys:sync` uses).
POSTHOG_APP_HOST = os.environ.get("POSTHOG_APP_HOST", "")
POSTHOG_PROJECT_ID = os.environ.get("POSTHOG_PROJECT_ID", "")
POSTHOG_PERSONAL_API_KEY = os.environ.get("POSTHOG_PERSONAL_API_KEY", "")
# Langfuse project key pair (same as `pnpm langfuse:prompts`).
LANGFUSE_HOST = os.environ.get("LANGFUSE_HOST", "")
LANGFUSE_PUBLIC_KEY = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
LANGFUSE_SECRET_KEY = os.environ.get("LANGFUSE_SECRET_KEY", "")
# Chatwoot account of the website inbox and an administrator's access token (deleting contacts
# needs the administrator role; the triage bot's CHATWOOT_API_TOKEN cannot).
CHATWOOT_ACCOUNT_ID = os.environ.get("CHATWOOT_ACCOUNT_ID", "")
CHATWOOT_ADMIN_API_TOKEN = os.environ.get("CHATWOOT_ADMIN_API_TOKEN", "")
# GA4 user deletion (Admin API submitUserDeletion, scope analytics.edit): property id (digits)
# and the key JSON (one line) of a service account with Editor access to the property.
GA4_PROPERTY_ID = os.environ.get("GA4_PROPERTY_ID", "")
GA4_SERVICE_ACCOUNT_JSON = os.environ.get("GA4_SERVICE_ACCOUNT_JSON", "")

# Billing (docs/billing.md): plans and limits, shared with the API.
PLANS_FILE = Path(os.environ.get("PLANS_FILE", _ROOT / "config" / "plans.json"))
