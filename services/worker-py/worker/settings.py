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

# LLM-ops (docs/adr/0009-llm-ops.md). Judge model for the drift check: unset = drift check off.
AI_JUDGE_PROVIDER = os.environ.get("AI_JUDGE_PROVIDER", "")
AI_JUDGE_MODEL = os.environ.get("AI_JUDGE_MODEL", "")
AI_DRIFT_CRON = os.environ.get("AI_DRIFT_CRON", "0 3 * * *")  # daily 03:00 UTC
AI_DRIFT_SAMPLE = int(os.environ.get("AI_DRIFT_SAMPLE", "20"))  # calls per purpose and org
AI_DRIFT_LOOKBACK_HOURS = int(os.environ.get("AI_DRIFT_LOOKBACK_HOURS", "48"))
# Traces only (e.g. Langfuse's OTLP endpoint, which takes no metrics); overrides the base URL.
OTEL_TRACES_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
# Full profile (`--profile llmops`): scores are also pushed to Langfuse. Empty = off.
LANGFUSE_HOST = os.environ.get("LANGFUSE_HOST", "")
LANGFUSE_PUBLIC_KEY = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
LANGFUSE_SECRET_KEY = os.environ.get("LANGFUSE_SECRET_KEY", "")
