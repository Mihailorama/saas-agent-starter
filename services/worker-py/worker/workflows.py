from contextlib import suppress
from datetime import datetime, timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.workflow import ParentClosePolicy

with workflow.unsafe.imports_passed_through():
    from worker.activities import Activities, ProjectCreated
    from worker.billing import RENEWED_BY_WORKER, BillingActivities, BillingEvent, Renewal


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


@workflow.defn(name="BillingEventWorkflow")
class BillingEventWorkflow:
    """Started by the API's webhook route with id `billing-<provider>-<event id>` (idempotent).

    For providers the worker renews (YooKassa), an activated/renewed period schedules the
    charge for its end as a child workflow that outlives this one.
    """

    @workflow.run
    async def run(self, event: BillingEvent) -> bool:
        # The DB may be down for a while; the provider already got its 200, so keep trying.
        applied = await workflow.execute_activity_method(
            BillingActivities.apply_billing_event,
            event,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_interval=timedelta(minutes=5)),
        )
        renews = event.type in ("subscription.activated", "subscription.renewed")
        if applied and renews and event.provider in RENEWED_BY_WORKER and event.periodEnd:
            with suppress(WorkflowAlreadyStartedError):  # this period's renewal is scheduled
                await workflow.start_child_workflow(
                    SubscriptionRenewalWorkflow.run,
                    Renewal(orgId=event.orgId, periodEnd=event.periodEnd),
                    id=f"billing-renewal-{event.orgId}-{event.periodEnd}",
                    parent_close_policy=ParentClosePolicy.ABANDON,
                )
        return applied


@workflow.defn(name="SubscriptionRenewalWorkflow")
class SubscriptionRenewalWorkflow:
    """Sleeps until the period ends, then charges the next one (or ends a canceled one)."""

    @workflow.run
    async def run(self, renewal: Renewal) -> str:
        wait = datetime.fromisoformat(renewal.periodEnd) - workflow.now()
        if wait > timedelta(0):
            await workflow.sleep(wait)
        # Retries stay well inside YooKassa's 24-hour idempotence window (about 3 hours).
        return await workflow.execute_activity_method(
            BillingActivities.charge_renewal,
            renewal,
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=RetryPolicy(
                initial_interval=timedelta(seconds=30),
                maximum_interval=timedelta(hours=1),
                maximum_attempts=10,
            ),
        )
