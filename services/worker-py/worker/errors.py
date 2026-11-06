"""Error reporting over the Sentry protocol (Sentry or GlitchTip; only the DSN differs).

No-op unless SENTRY_DSN is set. Errors only: traces stay in OpenTelemetry, and every event
carries the OTel trace_id so Grafana/Jaeger and the error tracker link to each other.
"""

from typing import Any, cast

import sentry_sdk
from opentelemetry import trace
from sentry_sdk.types import Event, Hint
from temporalio import activity
from temporalio.worker import (
    ActivityInboundInterceptor,
    ExecuteActivityInput,
    Interceptor,
)

from worker import settings


def scrub(event: Event, _hint: Hint) -> Event:
    """Drops what can carry PII, secrets or AI content (prompts never leave the gateway's S3)."""
    data = cast("dict[str, Any]", event)
    for key in ("request", "user", "extra"):
        data.pop(key, None)
    exception = cast("dict[str, Any]", data.get("exception") or {})
    for exc in cast("list[dict[str, Any]]", exception.get("values") or []):
        stacktrace = cast("dict[str, Any]", exc.get("stacktrace") or {})
        frames = cast("list[dict[str, Any]]", stacktrace.get("frames") or [])
        for frame in frames:
            frame.pop("vars", None)
    ctx = trace.get_current_span().get_span_context()
    if ctx.is_valid:
        trace_id = f"{ctx.trace_id:032x}"
        data.setdefault("tags", {})["trace_id"] = trace_id
        data.setdefault("contexts", {})["trace"] = {
            "trace_id": trace_id,
            "span_id": f"{ctx.span_id:016x}",
        }
    return event


def setup_errors() -> None:
    if not settings.SENTRY_DSN:
        return
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.SENTRY_ENVIRONMENT,
        release=settings.SENTRY_RELEASE or None,
        send_default_pii=False,
        include_local_variables=False,
        max_request_body_size="never",
        auto_enabling_integrations=False,  # no SQL/HTTP breadcrumbs with query text
        before_send=scrub,
    )


class _ActivityErrors(ActivityInboundInterceptor):
    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        try:
            return await super().execute_activity(input)
        except Exception as err:
            # ponytail: reports every attempt; the tracker groups retries into one issue.
            info = activity.info()
            with sentry_sdk.new_scope() as scope:
                scope.set_tag("temporal.activity_type", info.activity_type)
                scope.set_tag("temporal.workflow_type", info.workflow_type or "")
                scope.set_tag("temporal.attempt", str(info.attempt))
                scope.set_context("temporal", {"workflow_id": info.workflow_id})
                sentry_sdk.capture_exception(err)
            raise


class ErrorInterceptor(Interceptor):
    """Reports activity failures; the Temporal SDK catches them, so nothing else would."""

    def intercept_activity(self, next: ActivityInboundInterceptor) -> ActivityInboundInterceptor:
        return _ActivityErrors(next)
