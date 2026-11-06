"""Drift control: LLM-as-a-judge and rule scores for recent calls (docs/adr/0009-llm-ops.md).

The judge prompt is the same file Promptfoo uses in evals/<purpose>, so offline evals and
production monitoring grade by the same criteria.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, cast

import asyncpg
from temporalio import activity

from worker import prompts
from worker.ai import Gateway, Message, record_score
from worker.langfuse import push_score

# purpose -> judge prompt (prompts/judge/<purpose>.v<N>.md). Purposes not listed are not judged.
JUDGES: dict[str, tuple[str, int]] = {"project.summary": ("judge/project.summary", 1)}
# purpose -> deterministic checks on the output text, each 0 or 1 (mirrors evals assertions).
RULES: dict[str, dict[str, Callable[[str], bool]]] = {
    "project.summary": {"max_30_words": lambda out: len(out.split()) <= 30},
}


@dataclass(frozen=True)
class DriftCheck:
    """Workflow input of DriftCheckWorkflow (started by the Temporal schedule)."""

    perPurpose: int
    lookbackHours: int


@dataclass(frozen=True)
class DriftItem:
    orgId: str
    callId: str


@dataclass(frozen=True)
class JudgeChoice:
    provider: str
    model: str


def parse_verdict(text: str) -> float | None:
    """Score in [0, 1] from the judge's JSON answer, or None if it is not usable."""
    start, end = text.find("{"), text.rfind("}")
    try:
        doc: Any = json.loads(text[start : end + 1]) if start >= 0 else None
    except json.JSONDecodeError:
        return None
    score = cast(dict[str, object], doc).get("score") if isinstance(doc, dict) else None
    if isinstance(score, bool) or not isinstance(score, int | float) or not 0 <= score <= 1:
        return None
    return float(score)


class JudgeActivities:
    def __init__(self, pool: asyncpg.Pool, ai: Gateway | None, judge: JudgeChoice | None) -> None:
        self.pool, self.ai, self.judge = pool, ai, judge

    @activity.defn(name="sample_for_drift")
    async def sample_for_drift(self, check: DriftCheck) -> list[DriftItem]:
        """Up to N recent, successful, not yet scored calls per judged purpose and org.

        A call is scored once; an unusable verdict leaves only the rule scores (not retried).
        """
        items: list[DriftItem] = []
        async with self.pool.acquire() as conn:
            # ponytail: one query per org; a SECURITY DEFINER sampler if orgs reach thousands.
            org_ids = [r["id"] for r in await conn.fetch("select id from organization")]
            for org_id in org_ids:
                async with conn.transaction():
                    await conn.execute("select set_config('app.org_id', $1, true)", org_id)
                    rows = await conn.fetch(
                        "select id from ("
                        "  select id, row_number() over (partition by purpose"
                        "    order by created_at desc) as n"
                        "  from ai_calls c where purpose = any($1::text[]) and status = 'ok'"
                        "    and response_key is not null and created_at > now() - $2::interval"
                        "    and not exists (select 1 from ai_scores s"
                        "      where s.call_id = c.id and s.source in ('judge', 'rule'))"
                        ") ranked where n <= $3",
                        list(JUDGES),
                        timedelta(hours=check.lookbackHours),
                        check.perPurpose,
                    )
                items += [DriftItem(org_id, str(r["id"])) for r in rows]
        return items

    @activity.defn(name="judge_call")
    async def judge_call(self, item: DriftItem) -> float | None:
        """Judges one call and appends judge + rule scores. Safe to retry (scores written once)."""
        if self.ai is None or self.judge is None:
            return None
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", item.orgId)
            call = await conn.fetchrow("select * from ai_calls where id = $1", item.callId)
            done = await conn.fetchval(
                "select 1 from ai_scores where call_id = $1 and source in ('judge', 'rule')",
                item.callId,
            )
        if call is None or done or call["purpose"] not in JUDGES or not call["response_key"]:
            return None
        request = json.loads(await self.ai.s3.get(call["request_key"]))
        output: str = json.loads(await self.ai.s3.get(call["response_key"]))["text"]
        given = "\n\n".join(m["content"] for m in request["messages"] if m["role"] == "user")
        judge_prompt = prompts.load(*JUDGES[call["purpose"]])
        verdict = await self.ai.call_llm(
            "judge",
            [Message("user", judge_prompt.render(input=given, output=output))],
            model=self.judge.model,
            provider=self.judge.provider,
            org_id=item.orgId,
            actor_id=None,
            prompt_template_id=judge_prompt.id,
            prompt_template_version=judge_prompt.version,
            max_tokens=512,
        )
        score = parse_verdict(verdict.text)
        scores: list[tuple[str, str, float, str | None]] = [
            ("rule", name, float(check(output)), None)
            for name, check in RULES.get(call["purpose"], {}).items()
        ]
        if score is not None:
            scores.append(("judge", "quality", score, str(verdict.call_id)))
        else:
            activity.logger.warning("judge call %s: unusable verdict", verdict.call_id)
        written: list[tuple[str, str, float]] = []
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", item.orgId)
            # Same transaction as the inserts: a concurrent retry cannot double-write.
            await conn.execute("select pg_advisory_xact_lock(hashtext($1))", item.callId)
            if await conn.fetchval(
                "select 1 from ai_scores where call_id = $1 and source in ('judge', 'rule')",
                item.callId,
            ):
                return score
            for source, name, value, judge_call_id in scores:
                score_id = await conn.fetchval(
                    "insert into ai_scores (org_id, call_id, source, name, value, judge_call_id)"
                    " values ($1, $2, $3, $4, $5, $6) returning id",
                    item.orgId,
                    item.callId,
                    source,
                    name,
                    value,
                    judge_call_id,
                )
                written.append((str(score_id), name, value))
                record_score(
                    purpose=call["purpose"],
                    template=call["prompt_template_id"],
                    version=call["prompt_template_version"],
                    model=call["request_model"],
                    source=source,
                    name=name,
                    value=value,
                )
        for score_id, name, value in written:
            await push_score(
                score_id=score_id,
                trace_id=call["trace_id"],
                span_id=call["span_id"],
                name=name,
                value=value,
            )
        return score
