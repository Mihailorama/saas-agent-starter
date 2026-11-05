from dataclasses import dataclass

import asyncpg
from temporalio import activity
from temporalio.exceptions import ApplicationError

from worker.text import simhash


@dataclass(frozen=True)
class ProjectCreated:
    """Workflow input. Contract with apps/api/src/temporal.ts (camelCase JSON)."""

    orgId: str
    projectId: str
    name: str


class Activities:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

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
