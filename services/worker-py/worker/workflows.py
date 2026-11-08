import asyncio
import contextlib
from datetime import datetime, timedelta
from typing import Any

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
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.workflow import ParentClosePolicy

with workflow.unsafe.imports_passed_through():
    import worker.settings as settings
    from worker.activities import Activities, ProjectCreated
    from worker.billing import BillingActivities, BillingEvent, ContractPeriod
    from worker.credits import GRANT_ATTEMPTS, CreditActivities
    from worker.crm import CrmActivities, CrmEvent
    from worker.mail import SendEmail, send_email
    from worker.privacy import (
        CORE_STEPS,
        ORG_STEPS,
        USER_STEPS,
        Finish,
        PrivacyActivities,
        PrivacyRequest,
        Step,
    )
    from worker.support import SupportActivities, SupportConversation, SupportIssueClosed
    from worker.tracker import TrackerActivities, TrackerItem
    from worker.usage import UsageActivities
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


@workflow.defn(name="TrackerItemWorkflow")
class TrackerItemWorkflow:
    """Started by POST /api/hooks/posthog, id `tracker-item-<hash of the redacted text>`."""

    @workflow.run
    async def run(self, item: TrackerItem) -> str:
        return await workflow.execute_activity_method(
            TrackerActivities.file_item,
            item,
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=10), maximum_attempts=10),
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
RETENTION_SCHEDULE_ID = "privacy-retention"


async def ensure_maintenance_schedule(
    client: Client, task_queue: str, schedule_id: str = MAINTENANCE_SCHEDULE_ID
) -> None:
    await ensure_schedule(client, WebhookMaintenanceWorkflow.run, task_queue, schedule_id)


async def ensure_retention_schedule(
    client: Client, task_queue: str, schedule_id: str = RETENTION_SCHEDULE_ID
) -> None:
    await ensure_schedule(client, PrivacyRetentionWorkflow.run, task_queue, schedule_id)


async def ensure_schedule(
    client: Client,
    run: Any,
    task_queue: str,
    schedule_id: str,
    every: timedelta = timedelta(days=1),
) -> None:
    """Creates a schedule (daily by default) once; later worker starts leave it as it is (edit
    or pause it in the Temporal UI). Settings are read by the activities at run time."""
    schedule = Schedule(
        action=ScheduleActionStartWorkflow(run, id=schedule_id, task_queue=task_queue),
        spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=every)]),
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )
    with contextlib.suppress(ScheduleAlreadyRunningError):
        await client.create_schedule(schedule_id, schedule)


USAGE_SCHEDULE_ID = "billing-usage-report"


async def ensure_usage_schedule(client: Client, task_queue: str) -> None:
    await ensure_schedule(
        client, UsageReportWorkflow.run, task_queue, USAGE_SCHEDULE_ID, timedelta(minutes=15)
    )


@workflow.defn(name="UsageReportWorkflow")
class UsageReportWorkflow:
    """Every 15 minutes (Temporal Schedule `billing-usage-report`): usage to the provider's
    meters (worker/usage.py), one activity per org with its own retries. A failed org is picked
    up from its own mark by the next run; the others go on."""

    @workflow.run
    async def run(self) -> dict[str, int]:
        orgs = await workflow.execute_activity_method(
            UsageActivities.usage_orgs,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        results = await asyncio.gather(
            *(
                workflow.execute_activity_method(
                    UsageActivities.report_org_usage,
                    org,
                    start_to_close_timeout=timedelta(minutes=5),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                for org in orgs
            ),
            return_exceptions=True,
        )
        failed = sum(isinstance(r, BaseException) for r in results)
        events = sum(r for r in results if isinstance(r, int))
        return {"orgs": len(orgs), "events": events, "failed": failed}


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
        # A paid credit pack becomes a grant in the provider (docs/billing.md "Prepaid credits").
        if event.type == "credits.purchased" and workflow.patched("credit-grants"):
            try:
                await workflow.execute_activity_method(
                    CreditActivities.grant_credits,
                    event,
                    start_to_close_timeout=timedelta(seconds=30),
                    # Inside Stripe's 24-hour idempotency window, so a retry never grants twice.
                    retry_policy=RetryPolicy(
                        maximum_interval=timedelta(minutes=5), maximum_attempts=GRANT_ATTEMPTS
                    ),
                )
            except ActivityError:
                # Any final failure, a timeout included: the paid pack goes on the record.
                await workflow.execute_activity_method(
                    CreditActivities.record_grant_failure,
                    event,
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_interval=timedelta(minutes=5)),
                )
                raise
        # Deal stage in the CRM (docs/crm.md), only for events that changed our state. The child
        # maps the subscription row as it is when it runs, so a retried older child cannot move
        # the deal back. A child, so a CRM outage never holds the billing workflow open.
        # `patched`: runs started before this code replay as-is.
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


@workflow.defn(name="ContractPeriodWorkflow")
class ContractPeriodWorkflow:
    """A durable timer to the end of a manual contract's period, then `end_contract_period`.
    Started by the operator console with id `billing-contract-<org>-<period end ms>`."""

    @workflow.run
    async def run(self, p: ContractPeriod) -> str:
        wait = datetime.fromisoformat(p.periodEnd) - workflow.now()
        if wait > timedelta(0):
            await workflow.sleep(wait)
        return await workflow.execute_activity_method(
            BillingActivities.end_contract_period,
            p,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_interval=timedelta(minutes=5)),
        )


@workflow.defn(name="CrmSyncWorkflow")
class CrmSyncWorkflow:
    """One source event -> the CRM. Id `crm-<eventId>`, started by the API (verified sign-up, org,
    PostHog signal, Chatwoot, booking) or by BillingEventWorkflow; duplicates are rejected."""

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


# --- Data-subject rights (worker/privacy.py, docs/privacy.md) ---------------------------------

LONG = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    backoff_coefficient=2,
    maximum_interval=timedelta(hours=1),
)


@workflow.defn(name="DataExportWorkflow")
class DataExportWorkflow:
    """Started by the API, id `privacy-export-<requestId>`: one ZIP in S3, then the "ready" mail."""

    @workflow.run
    async def run(self, req: PrivacyRequest) -> dict[str, Any]:
        try:
            result = await workflow.execute_activity_method(
                PrivacyActivities.build_export,
                req,
                start_to_close_timeout=timedelta(minutes=30),
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=10), maximum_attempts=5
                ),
            )
        except ActivityError:
            await workflow.execute_activity_method(
                PrivacyActivities.mark_failed, req, start_to_close_timeout=timedelta(seconds=30)
            )
            raise
        if req.email:
            # Same delivery and retries as SendEmailWorkflow, on the mail worker's queue.
            await workflow.execute_activity(
                send_email,
                req.email,
                task_queue=settings.EMAIL_TASK_QUEUE,
                start_to_close_timeout=timedelta(seconds=60),
                schedule_to_close_timeout=timedelta(hours=24),
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=5), maximum_interval=timedelta(minutes=5)
                ),
            )
        return result


@workflow.defn(name="DataDeletionWorkflow")
class DataDeletionWorkflow:
    """Started by the API, id `privacy-deletion-<requestId>`. Waits out the grace period (signal
    `cancel` wakes it early), then runs each step as its own retried activity: a crash resumes
    at the step that did not finish. The report lists every step's outcome."""

    def __init__(self) -> None:
        self._cancelled = False

    @workflow.signal
    def cancel(self) -> None:
        self._cancelled = True

    @workflow.run
    async def run(self, req: PrivacyRequest) -> dict[str, Any]:
        wait = datetime.fromisoformat(req.executeAfter) - workflow.now()
        if wait > timedelta(0):
            with contextlib.suppress(TimeoutError):
                await workflow.wait_condition(lambda: self._cancelled, timeout=wait)
        started = await workflow.execute_activity_method(
            PrivacyActivities.begin_deletion,
            req,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=LONG,
        )
        if not started:  # cancelled, or refused (reason in the request's report)
            return {"status": "not started"}
        report: dict[str, Any] = {}
        steps = USER_STEPS if req.subjectType == "user" else ORG_STEPS
        # `patched`: a deletion already running its steps when "twenty" was added replays as-is.
        steps = [n for n in steps if n != "twenty" or workflow.patched("privacy-twenty")]
        for name in steps:
            try:
                report[name] = await workflow.execute_activity_method(
                    PrivacyActivities.deletion_step,
                    Step(req, name),
                    start_to_close_timeout=timedelta(minutes=15),
                    retry_policy=LONG
                    if name in CORE_STEPS
                    else RetryPolicy(
                        initial_interval=timedelta(seconds=30),
                        backoff_coefficient=2,
                        maximum_interval=timedelta(hours=1),
                        maximum_attempts=8,
                    ),
                )
            except ActivityError as err:
                cause = err.cause
                detail = cause.message if isinstance(cause, ApplicationError) else "error"
                report[name] = {"status": "failed", "detail": detail}
        await workflow.execute_activity_method(
            PrivacyActivities.finish_deletion,
            Finish(req, report),
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=LONG,
        )
        return report


@workflow.defn(name="PrivacyRetentionWorkflow")
class PrivacyRetentionWorkflow:
    """Daily (Temporal Schedule `privacy-retention`): deletes AI request/response content past
    ai_calls.content_expires_at, expired data exports, deleted organizations whose record
    period ended, tracker items a TrackerItemWorkflow left in S3 and leftover booking payloads.
    The previous run's result is the watermark, so each AI call is visited once."""

    @workflow.run
    async def run(self) -> dict[str, Any]:
        timeout, retry = timedelta(hours=1), RetryPolicy(maximum_attempts=3)
        last: dict[str, Any] = (
            workflow.get_last_completion_result(dict[str, Any]) or {}
            if workflow.has_last_completion_result()
            else {}
        )
        since: str | None = last.get("until")
        content = await workflow.execute_activity_method(
            PrivacyActivities.purge_ai_content,
            since,
            start_to_close_timeout=timeout,
            retry_policy=retry,
        )
        exports = await workflow.execute_activity_method(
            PrivacyActivities.purge_exports, start_to_close_timeout=timeout, retry_policy=retry
        )
        orgs = await workflow.execute_activity_method(
            PrivacyActivities.purge_deleted_orgs, start_to_close_timeout=timeout, retry_policy=retry
        )
        inbox = await workflow.execute_activity_method(
            PrivacyActivities.purge_tracker_inbox,
            start_to_close_timeout=timeout,
            retry_policy=retry,
        )
        bookings = 0
        if workflow.patched("booking-payloads"):
            bookings = await workflow.execute_activity_method(
                PrivacyActivities.purge_booking_payloads,
                start_to_close_timeout=timeout,
                retry_policy=retry,
            )
        return {
            **content,
            "exports": exports,
            "orgs": orgs,
            "tracker_inbox": inbox,
            "bookings": bookings,
        }
