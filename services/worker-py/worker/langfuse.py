"""Optional push of ai_scores to Langfuse (Full profile, docs/adr/0009-llm-ops.md).

ai_scores in Postgres is the record; this copy is best effort. The score id is ours, so a
retried push upserts the same Langfuse score instead of adding a second one.
"""

import logging

import httpx2

from worker import settings

log = logging.getLogger(__name__)


async def push_score(
    *,
    score_id: str,
    trace_id: str | None,
    span_id: str | None,
    name: str,
    value: float,
    comment: str | None = None,
) -> None:
    if not (settings.LANGFUSE_HOST and settings.LANGFUSE_PUBLIC_KEY and trace_id):
        return
    body = {
        "id": score_id,
        "traceId": trace_id,
        "observationId": span_id,
        "name": name,
        "value": value,
        "dataType": "NUMERIC",
        "comment": comment,
    }
    try:
        async with httpx2.AsyncClient(timeout=10) as http:
            res = await http.post(
                f"{settings.LANGFUSE_HOST.rstrip('/')}/api/public/scores",
                # Langfuse v4 takes a list of scores (202 accepted, 207 partially).
                json=[{k: v for k, v in body.items() if v is not None}],
                auth=(settings.LANGFUSE_PUBLIC_KEY, settings.LANGFUSE_SECRET_KEY),
            )
            res.raise_for_status()
    except httpx2.HTTPError as err:
        log.warning("langfuse score push failed for %s: %s", score_id, type(err).__name__)
