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
