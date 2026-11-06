from typing import Any, cast

from opentelemetry.sdk.trace import TracerProvider

from worker.errors import scrub


def test_scrub_drops_pii_and_locals_and_adds_trace_id() -> None:
    event: dict[str, Any] = {
        "request": {"data": "secret"},
        "user": {"email": "a@example.com"},
        "extra": {"prompt": "x"},
        "exception": {
            "values": [{"stacktrace": {"frames": [{"function": "f", "vars": {"p": 1}}]}}]
        },
    }
    with TracerProvider().get_tracer("t").start_as_current_span("s") as span:
        out = cast("dict[str, Any]", scrub(cast("Any", event), {}))
        trace_id = f"{span.get_span_context().trace_id:032x}"
    assert "request" not in out and "user" not in out and "extra" not in out
    assert "vars" not in out["exception"]["values"][0]["stacktrace"]["frames"][0]
    assert out["tags"]["trace_id"] == trace_id
    assert out["contexts"]["trace"]["trace_id"] == trace_id
