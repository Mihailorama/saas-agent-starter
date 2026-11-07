import asyncio
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from worker.activities import Activities, ProjectCreated
    from worker.webhooks import WebhookActivities, WebhookDelivery, WebhookEvent


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


@workflow.defn(name="WebhookEventWorkflow")
class WebhookEventWorkflow:
    """Started by the API (`webhook-event-<eventId>`, or `webhook-replay-...`): delivers one event
    to each of its endpoints in parallel; each attempt is one activity run, retried with backoff."""

    @workflow.run
    async def run(self, event: WebhookEvent) -> list[str]:
        retry = RetryPolicy(
            initial_interval=timedelta(seconds=event.retryInitialSeconds),
            backoff_coefficient=3,
            maximum_interval=timedelta(hours=6),
            maximum_attempts=event.maxAttempts,
        )
        return list(
            await asyncio.gather(
                *(
                    workflow.execute_activity_method(
                        WebhookActivities.deliver_webhook,
                        WebhookDelivery(event.orgId, delivery_id, event.replay, event.maxAttempts),
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=retry,
                    )
                    for delivery_id in event.deliveryIds
                )
            )
        )
