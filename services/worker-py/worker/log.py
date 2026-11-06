import json
import logging
from datetime import UTC, datetime
from typing import override

from opentelemetry import trace


class JsonFormatter(logging.Formatter):
    @override
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        ctx = trace.get_current_span().get_span_context()
        if ctx.is_valid:  # Grafana links Loki lines to Jaeger traces by trace_id
            entry["trace_id"], entry["span_id"] = f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}"
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=level, handlers=[handler], force=True)
    logging.getLogger("httpx2").setLevel(logging.WARNING)  # one INFO line per HTTP request
