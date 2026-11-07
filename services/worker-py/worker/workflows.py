from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from worker.activities import Activities, ProjectCreated
    from worker.billing import BillingActivities, BillingEvent
    from worker.mail import SendEmail, send_email
    from worker.support import SupportActivities, SupportConversation, SupportIssueClosed


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
        return await workflow.execute_activity_method(
            BillingActivities.apply_billing_event,
            event,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_interval=timedelta(minutes=5)),
        )
