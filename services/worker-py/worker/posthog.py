"""LLM observability in PostHog (docs/adr/0009-llm-ops.md): one `$ai_generation` per call.

Sent with PostHog's capture API (no SDK). `$ai_trace_id` is our OTel trace id, so feedback the
browser sends for the same trace (apps/web/src/lib/feedback.ts) attaches to the same trace.
Privacy mode (POSTHOG_PRIVACY_MODE, default on) leaves `$ai_input` / `$ai_output_choices` out:
PostHog then gets metadata only (model, tokens, cost, latency, outcome), like our spans.
Best effort: ai_calls stays the record; a PostHog outage never fails an LLM call.
"""

import logging
from collections.abc import Sequence
from datetime import datetime
from typing import Any

import httpx2

from worker.providers import Message, message_dict

log = logging.getLogger(__name__)


class PostHogAi:
    def __init__(
        self, *, host: str, api_key: str, privacy_mode: bool, http: httpx2.AsyncClient | None = None
    ) -> None:
        self.url = f"{host.rstrip('/')}/i/v0/e/"
        self.api_key, self.privacy_mode = api_key, privacy_mode
        self._http = http or httpx2.AsyncClient(timeout=10)

    async def close(self) -> None:
        await self._http.aclose()

    async def capture_generation(
        self, row: dict[str, Any], messages: Sequence[Message], output: str | None
    ) -> None:
        props: dict[str, Any] = {
            "$ai_trace_id": row.get("trace_id") or str(row["id"]),
            "$ai_span_id": row.get("span_id") or str(row["id"]),
            "$ai_span_name": row["purpose"],
            "$ai_model": row.get("response_model") or row["request_model"],
            "$ai_provider": row["provider"],
            "$ai_input_tokens": row.get("input_tokens"),
            "$ai_output_tokens": row.get("output_tokens"),
            "$ai_latency": row["latency_ms"] / 1000,
            "$ai_is_error": row["status"] == "error",
            "$ai_error": row.get("error_class"),
            # Ours, for filters and breakdowns (ids and versions only).
            "ai_call_id": str(row["id"]),
            "ai_purpose": row["purpose"],
            "ai_prompt_template": row["prompt_template_id"],
            "ai_prompt_version": row["prompt_template_version"],
            "ai_contour": row["contour"],
            "$groups": {"organization": row["org_id"]},
            "$process_person_profile": False,
        }
        if row.get("cost") is not None and row.get("cost_currency") == "USD":
            props["$ai_total_cost_usd"] = float(row["cost"])
        if not self.privacy_mode:
            props["$ai_input"] = [message_dict(m) for m in messages]
            if output is not None:
                props["$ai_output_choices"] = [{"role": "assistant", "content": output}]
        body = {
            "api_key": self.api_key,
            "event": "$ai_generation",
            "distinct_id": row.get("actor_id") or f"org:{row['org_id']}",
            "properties": {k: v for k, v in props.items() if v is not None},
            "timestamp": datetime.now().astimezone().isoformat(),
        }
        try:
            res = await self._http.post(self.url, json=body)
            res.raise_for_status()
        except httpx2.HTTPError as err:  # class only: messages can echo the request
            log.warning("posthog capture failed for ai call %s: %s", row["id"], type(err).__name__)
