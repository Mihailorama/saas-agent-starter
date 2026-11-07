from dataclasses import dataclass

import asyncpg
from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker.ai import Gateway, Message
from worker.billing import SpendLimitExceeded
from worker.text import simhash


@dataclass(frozen=True)
class ProjectCreated:
    """Workflow input. Contract with apps/api/src/temporal.ts (camelCase JSON).

    Carries ids only: the description is read from the DB, so no user content ends up in
    Temporal's workflow history.
    """

    orgId: str
    projectId: str
    name: str
    actorId: str | None = None


@dataclass(frozen=True)
class ModelChoice:
    provider: str
    model: str


SUMMARY_PURPOSE = "project.summary"
SUMMARY_TEMPLATE = ("project.summary", "1")  # bump the version when the prompt changes
SUMMARY_PROMPT = (
    "Summarize the project description you are given in one plain sentence of at most"
    " 30 words. Answer with the sentence only."
)


class Activities:
    def __init__(
        self,
        pool: asyncpg.Pool,
        ai: Gateway | None = None,
        summary_model: ModelChoice | None = None,
    ) -> None:
        self.pool = pool
        self.ai = ai
        self.summary_model = summary_model  # None: summaries are off (no default model)

    @activity.defn(name="fingerprint_project")
    async def fingerprint_project(self, event: ProjectCreated) -> str:
        """Stores the project's SimHash. Safe to retry: the write happens at most once."""
        fingerprint = f"{simhash(event.name):016x}"
        async with self.pool.acquire() as conn, conn.transaction():
            # Same tenant scoping as the API: RLS only shows this org's rows.
            await conn.execute("select set_config('app.org_id', $1, true)", event.orgId)
            updated = await conn.fetchval(
                "update projects set fingerprint = $1"
                " where id = $2 and fingerprint is null returning id",
                fingerprint,
                event.projectId,
            )
            if updated is None:
                if await conn.fetchval("select 1 from projects where id = $1", event.projectId):
                    return fingerprint  # already done by an earlier attempt
                raise ApplicationError("project not found", non_retryable=True)
            await conn.execute(
                "insert into audit_log (org_id, actor_id, action, target)"
                " values ($1, 'worker', 'project.fingerprinted', $2)",
                event.orgId,
                event.projectId,
            )
        activity.logger.info("fingerprinted project %s", event.projectId)
        return fingerprint

    @activity.defn(name="summarize_project")
    async def summarize_project(self, event: ProjectCreated) -> str | None:
        """Stores an AI summary of the description (ai_status=generated) for human review.

        Skipped when AI is not configured or there is no description. Safe to retry: the
        summary is written at most once (every LLM call made is still logged in ai_calls).
        """
        if self.ai is None or self.summary_model is None:
            return None
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", event.orgId)
            project = await conn.fetchrow(
                "select name, description, ai_summary from projects where id = $1",
                event.projectId,
            )
        if project is None:
            raise ApplicationError("project not found", non_retryable=True)
        if project["ai_summary"] is not None or not project["description"]:
            return project["ai_summary"]

        try:
            result = await self.ai.call_llm(
                SUMMARY_PURPOSE,
                [
                    Message("system", SUMMARY_PROMPT),
                    Message("user", f"Project: {project['name']}\n\n{project['description']}"),
                ],
                model=self.summary_model.model,
                provider=self.summary_model.provider,
                org_id=event.orgId,
                actor_id=event.actorId,
                prompt_template_id=SUMMARY_TEMPLATE[0],
                prompt_template_version=SUMMARY_TEMPLATE[1],
                max_tokens=2048,
            )
        except SpendLimitExceeded:
            # No summary for now; the billing page shows the LLM spend limit as reached.
            activity.logger.warning("project %s: summary skipped, spend limit", event.projectId)
            return None
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", event.orgId)
            updated = await conn.fetchval(
                "update projects set ai_summary = $1, ai_status = 'generated', ai_call_id = $2"
                " where id = $3 and ai_summary is null returning id",
                result.text.strip(),
                result.call_id,
                event.projectId,
            )
            if updated is not None:
                await conn.execute(
                    "insert into audit_log (org_id, actor_id, action, target)"
                    " values ($1, 'worker', 'project.ai_summarized', $2)",
                    event.orgId,
                    event.projectId,
                )
        activity.logger.info("summarized project %s (ai call %s)", event.projectId, result.call_id)
        return result.text
