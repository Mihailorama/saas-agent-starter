from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from worker.activities import Activities, ProjectCreated
    from worker.judge import DriftCheck, JudgeActivities


@workflow.defn(name="ProjectCreatedWorkflow")
class ProjectCreatedWorkflow:
    """Started by the API with workflow id `project-created-<projectId>` (idempotent)."""

    @workflow.run
    async def run(self, event: ProjectCreated) -> str:
        fingerprint = await workflow.execute_activity_method(
            Activities.fingerprint_project,
            event,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=1), maximum_attempts=5),
        )
        # LLM calls are slow and cost money: longer timeout, fewer retries.
        await workflow.execute_activity_method(
            Activities.summarize_project,
            event,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=5), maximum_attempts=3),
        )
        return fingerprint


@workflow.defn(name="DriftCheckWorkflow")
class DriftCheckWorkflow:
    """Started by the `ai-drift-check` schedule (worker/__main__.py). Returns calls judged."""

    @workflow.run
    async def run(self, check: DriftCheck) -> int:
        items = await workflow.execute_activity_method(
            JudgeActivities.sample_for_drift,
            check,
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        judged = 0
        # ponytail: sequential; fan out with asyncio.gather in batches if samples grow large.
        for item in items:
            score = await workflow.execute_activity_method(
                JudgeActivities.judge_call,
                item,
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(initial_interval=timedelta(seconds=5), maximum_attempts=3),
            )
            judged += score is not None
        return judged
