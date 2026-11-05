"""End to end against the compose stack: Temporal server + Postgres (migrated)."""

import uuid
from collections.abc import AsyncIterator

import asyncpg
import pytest
from temporalio.client import Client, WorkflowFailureError
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.worker import Worker

from tests.conftest import new_org
from worker import settings
from worker.activities import Activities, ProjectCreated
from worker.text import simhash
from worker.workflows import ProjectCreatedWorkflow

TASK_QUEUE = f"test-{uuid.uuid4()}"


@pytest.fixture(scope="session")
async def client(pool: asyncpg.Pool) -> AsyncIterator[Client]:
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[ProjectCreatedWorkflow],
        # No AI configured here: summarize_project is a no-op (tests/test_ai.py covers it).
        activities=[Activities(pool).fingerprint_project, Activities(pool).summarize_project],
    ):
        yield client


async def new_project(pool: asyncpg.Pool, name: str) -> ProjectCreated:
    org_id, project_id = await new_org(pool), str(uuid.uuid4())
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        await conn.execute(
            "insert into projects (id, org_id, name) values ($1, $2, $3)", project_id, org_id, name
        )
    return ProjectCreated(orgId=org_id, projectId=project_id, name=name)


async def audit_count(pool: asyncpg.Pool, event: ProjectCreated) -> int:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", event.orgId)
        count: int = await conn.fetchval(
            "select count(*) from audit_log where target = $1 and action = 'project.fingerprinted'",
            event.projectId,
        )
        return count


async def start(client: Client, event: ProjectCreated) -> str:
    # Same id scheme and reuse policy as apps/api/src/temporal.ts.
    return await client.execute_workflow(
        ProjectCreatedWorkflow.run,
        event,
        id=f"project-created-{event.projectId}",
        task_queue=TASK_QUEUE,
        id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
    )


async def test_workflow_completes_and_is_idempotent(client: Client, pool: asyncpg.Pool) -> None:
    event = await new_project(pool, "Apollo Guidance Computer")

    assert await start(client, event) == f"{simhash(event.name):016x}"
    assert await audit_count(pool, event) == 1

    # Same workflow id again: rejected, nothing runs twice.
    with pytest.raises(WorkflowAlreadyStartedError):
        await start(client, event)
    # A retried activity (e.g. after a worker crash) does not write twice either.
    await Activities(pool).fingerprint_project(event)
    assert await audit_count(pool, event) == 1


async def test_missing_project_fails_without_retry_storm(
    client: Client, pool: asyncpg.Pool
) -> None:
    event = ProjectCreated(orgId=str(uuid.uuid4()), projectId=str(uuid.uuid4()), name="ghost")
    with pytest.raises(WorkflowFailureError):
        await start(client, event)
