import asyncio
import contextlib
from datetime import timedelta

from temporalio import workflow
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
    ScheduleSpec,
)
from temporalio.common import RetryPolicy, WorkflowIDReusePolicy
from temporalio.workflow import ParentClosePolicy

with workflow.unsafe.imports_passed_through():
    from worker.activities import Activities, ProjectCreated
    from worker.billing import BillingActivities, BillingEvent
    from worker.crm import CrmActivities, CrmEvent
    from worker.mail import SendEmail, send_email
    from worker.support import SupportActivities, SupportConversation, SupportIssueClosed
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


@workflow.defn(name="SupportTriageWorkflow")
class SupportTriageWorkflow:
    """Started by POST /api/hooks/chatwoot, id `support-triage-<account>-<conversation>`."""

    @workflow.run
    async def run(self, c: SupportConversation) -> str:
        return await workflow.execute_activity_method(
            SupportActivities.triage,
            c,
            start_to_close_timeout=timedelta(minutes=3),  # up to two LLM calls
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=10), maximum_attempts=3),
        )


@workflow.defn(name="SupportIssueClosedWorkflow")
class SupportIssueClosedWorkflow:
    """Started by POST /api/hooks/{github,plane}, one id per close event."""

    @workflow.run
    async def run(self, e: SupportIssueClosed) -> int:
        return await workflow.execute_activity_method(
            SupportActivities.issue_closed,
            e,
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=5), maximum_attempts=5),
        )


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


@workflow.defn(name="WebhookMaintenanceWorkflow")
class WebhookMaintenanceWorkflow:
    """Daily (Temporal Schedule `webhook-maintenance`): retention, then re-encryption of secrets
    still under an older WEBHOOK_ENCRYPTION_KEYS entry."""

    @workflow.run
    async def run(self) -> dict[str, int]:
        timeout, retry = timedelta(minutes=30), RetryPolicy(maximum_attempts=3)
        pruned = await workflow.execute_activity_method(
            WebhookActivities.prune_webhooks, start_to_close_timeout=timeout, retry_policy=retry
        )
        reencrypted = await workflow.execute_activity_method(
            WebhookActivities.reencrypt_webhook_secrets,
            start_to_close_timeout=timeout,
            retry_policy=retry,
        )
        return {"pruned": pruned, "reencrypted": reencrypted}


MAINTENANCE_SCHEDULE_ID = "webhook-maintenance"


async def ensure_maintenance_schedule(
    client: Client, task_queue: str, schedule_id: str = MAINTENANCE_SCHEDULE_ID
) -> None:
    """Creates the daily maintenance schedule once; later worker starts leave it as it is
    (edit or pause it in the Temporal UI). Settings are read by the activities at run time."""
    schedule = Schedule(
        action=ScheduleActionStartWorkflow(
            WebhookMaintenanceWorkflow.run, id=schedule_id, task_queue=task_queue
        ),
        spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=timedelta(days=1))]),
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )
    with contextlib.suppress(ScheduleAlreadyRunningError):
        await client.create_schedule(schedule_id, schedule)


@workflow.defn(name="SendEmailWorkflow")
class SendEmailWorkflow:
    """Started by the API (apps/api/src/temporal.ts) with id `email-<kind>-<hash of the key>`."""

    @workflow.run
    async def run(self, email: SendEmail) -> str:
        # Retry SMTP outages for as long as the links stay valid (verification/reset: 1 hour).
        return await workflow.execute_activity(
            send_email,
            email,
            start_to_close_timeout=timedelta(seconds=60),
            schedule_to_close_timeout=timedelta(hours=1),
            retry_policy=RetryPolicy(
                initial_interval=timedelta(seconds=5),
                backoff_coefficient=2,
                maximum_interval=timedelta(minutes=5),
            ),
        )


@workflow.defn(name="BillingEventWorkflow")
class BillingEventWorkflow:
    """Started by the API's webhook route with id `billing-<provider>-<event id>` (idempotent)."""

    @workflow.run
    async def run(self, event: BillingEvent) -> bool:
        # The DB may be down for a while; the provider already got its 200, so keep trying.
        applied = await workflow.execute_activity_method(
            BillingActivities.apply_billing_event,
            event,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_interval=timedelta(minutes=5)),
        )
        # Deal stage in the CRM (docs/crm.md), only for events that changed our state: an older
        # event that arrives late must not move the deal back. A child, so a CRM outage never
        # holds the billing workflow open. `patched`: runs started before this code replay as-is.
        if applied and workflow.patched("crm-sync"):
            crm = CrmEvent(
                kind="billing",
                eventId=f"billing:{event.provider}:{event.eventId}",
                orgId=event.orgId,
                billingType=event.type,
            )
            await workflow.start_child_workflow(
                CrmSyncWorkflow.run,
                crm,
                id=f"crm-{crm.eventId}",
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                parent_close_policy=ParentClosePolicy.ABANDON,
            )
        return applied


@workflow.defn(name="CrmSyncWorkflow")
class CrmSyncWorkflow:
    """One source event -> the CRM. Id `crm-<eventId>`, started by the API (signup, org, PostHog
    signal, Chatwoot, Cal.com) or by BillingEventWorkflow; duplicates are rejected."""

    @workflow.run
    async def run(self, e: CrmEvent) -> str:
        # A CRM outage of a few hours is retried; after that the event shows as failed in the UI.
        return await workflow.execute_activity_method(
            CrmActivities.sync,
            e,
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=RetryPolicy(
                initial_interval=timedelta(seconds=5),
                maximum_interval=timedelta(minutes=10),
                maximum_attempts=25,
            ),
        )
