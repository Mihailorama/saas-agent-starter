import asyncio
import logging
import signal
from datetime import timedelta
from ipaddress import ip_network

import asyncpg
import httpx2
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from temporalio.client import Client
from temporalio.contrib.opentelemetry import TracingInterceptor
from temporalio.runtime import OpenTelemetryConfig, Runtime, TelemetryConfig
from temporalio.worker import Worker

from worker import settings
from worker.activities import Activities, ModelChoice
from worker.ai import PROVIDERS, Gateway, load_registry
from worker.billing import BillingActivities, load_plans
from worker.errors import ErrorInterceptor, setup_errors
from worker.log import configure_logging
from worker.mail import send_email
from worker.posthog import PostHogAi
from worker.s3 import S3
from worker.support import (
    Chatwoot,
    DryRunTracker,
    GitHubIssues,
    PlaneIntake,
    SupportActivities,
    Tracker,
)
from worker.text import backend
from worker.webhooks import WebhookActivities, parse_keys
from worker.workflows import (
    BillingEventWorkflow,
    ProjectCreatedWorkflow,
    SendEmailWorkflow,
    SupportIssueClosedWorkflow,
    SupportTriageWorkflow,
    WebhookEventWorkflow,
    WebhookMaintenanceWorkflow,
    ensure_maintenance_schedule,
)

log = logging.getLogger("worker")


def support_tracker(http: httpx2.AsyncClient) -> Tracker:
    """SUPPORT_TRACKER selects the adapter; missing credentials = dry run (docs/support.md)."""
    s = settings
    if s.SUPPORT_TRACKER == "plane":
        if s.PLANE_API_URL and s.PLANE_WORKSPACE and s.PLANE_PROJECT_ID and s.PLANE_API_TOKEN:
            return PlaneIntake(
                api_url=s.PLANE_API_URL,
                app_url=s.PLANE_APP_URL,
                workspace=s.PLANE_WORKSPACE,
                project_id=s.PLANE_PROJECT_ID,
                token=s.PLANE_API_TOKEN,
                http=http,
            )
    elif s.SUPPORT_TRACKER == "github":
        if s.GITHUB_TOKEN and s.GITHUB_REPO:
            return GitHubIssues(s.GITHUB_REPO, s.GITHUB_TOKEN, http)
    else:
        raise ValueError(f"SUPPORT_TRACKER must be github or plane, not {s.SUPPORT_TRACKER!r}")
    return DryRunTracker()


def setup_tracing() -> Runtime | None:
    """Traces and ai_* metrics via the OTel SDK; Temporal SDK metrics (temporal_*) via the Core
    runtime. The tracer provider is always installed, so every ai_calls row gets a trace id
    (PostHog/Langfuse feedback joins on it) even when no trace backend is configured."""
    resource = Resource.create({"service.name": "worker"})
    provider = TracerProvider(resource=resource)
    if settings.OTEL_ENDPOINT or settings.OTEL_TRACES_ENDPOINT:  # the latter: e.g. Langfuse
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    if not settings.OTEL_ENDPOINT:
        return None
    reader = PeriodicExportingMetricReader(OTLPMetricExporter())
    metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[reader]))
    temporal_metrics = OpenTelemetryConfig(
        url=f"{settings.OTEL_ENDPOINT}/v1/metrics", http=True, durations_as_seconds=True
    )
    return Runtime(telemetry=TelemetryConfig(metrics=temporal_metrics))


async def main() -> None:
    configure_logging()
    setup_errors()
    runtime = setup_tracing()
    client = await Client.connect(
        settings.TEMPORAL_ADDRESS,
        namespace=settings.TEMPORAL_NAMESPACE,
        interceptors=[TracingInterceptor()],
        runtime=runtime,
    )
    pool = await asyncpg.create_pool(settings.DATABASE_URL)
    s3 = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.AI_CONTENT_BUCKET,
    )
    posthog = (
        PostHogAi(
            host=settings.POSTHOG_HOST,
            api_key=settings.POSTHOG_KEY,
            privacy_mode=settings.POSTHOG_PRIVACY_MODE,
        )
        if settings.POSTHOG_HOST and settings.POSTHOG_KEY
        else None
    )
    plans = load_plans(settings.PLANS_FILE)
    ai: Gateway | None = None
    if settings.AI_CONTOUR:
        await s3.ensure_bucket()
        ai = Gateway(
            pool=pool,
            s3=s3,
            contour=settings.AI_CONTOUR,
            registry=load_registry(settings.AI_MODELS_FILE, settings.AI_CONTOUR),
            providers=PROVIDERS,
            retention_days=settings.AI_CONTENT_RETENTION_DAYS,
            posthog=posthog,
            plans=plans,
        )
    summary_model = (
        ModelChoice(settings.AI_PROJECT_SUMMARY_PROVIDER, settings.AI_PROJECT_SUMMARY_MODEL)
        if settings.AI_PROJECT_SUMMARY_PROVIDER and settings.AI_PROJECT_SUMMARY_MODEL
        else None
    )
    activities = Activities(pool, ai, summary_model)
    billing = BillingActivities(pool, plans)
    webhooks = WebhookActivities(
        pool,
        allowed_networks=[ip_network(c) for c in settings.WEBHOOK_ALLOWED_CIDRS],
        encryption_keys=parse_keys(settings.WEBHOOK_ENCRYPTION_KEYS),
        max_payload_bytes=settings.WEBHOOK_MAX_PAYLOAD_BYTES,
        disable_after_failures=settings.WEBHOOK_DISABLE_AFTER_FAILURES,
        retention_days=settings.WEBHOOK_RETENTION_DAYS,
    )
    await ensure_maintenance_schedule(client, settings.TEMPORAL_TASK_QUEUE)
    http = httpx2.AsyncClient(timeout=30)
    chatwoot = (
        Chatwoot(
            settings.CHATWOOT_URL, settings.CHATWOOT_API_TOKEN, settings.CHATWOOT_PUBLIC_URL, http
        )
        if settings.CHATWOOT_URL and settings.CHATWOOT_API_TOKEN
        else None
    )
    triage_model = (
        ModelChoice(settings.AI_SUPPORT_TRIAGE_PROVIDER, settings.AI_SUPPORT_TRIAGE_MODEL)
        if settings.AI_SUPPORT_TRIAGE_PROVIDER and settings.AI_SUPPORT_TRIAGE_MODEL
        else None
    )
    tracker = support_tracker(http)
    support = SupportActivities(
        chatwoot=chatwoot,
        tracker=tracker,
        ai=ai,
        model=triage_model,
        ai_org_id=settings.SUPPORT_AI_ORG_ID,
        notify=settings.SUPPORT_NOTIFY,
    )
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)

    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_TASK_QUEUE,
        workflows=[
            ProjectCreatedWorkflow,
            BillingEventWorkflow,
            SupportTriageWorkflow,
            SupportIssueClosedWorkflow,
            WebhookEventWorkflow,
            WebhookMaintenanceWorkflow,
        ],
        activities=[
            activities.fingerprint_project,
            activities.summarize_project,
            billing.apply_billing_event,
            support.triage,
            support.issue_closed,
            webhooks.deliver_webhook,
            webhooks.prune_webhooks,
            webhooks.reencrypt_webhook_secrets,
        ],
        graceful_shutdown_timeout=timedelta(seconds=10),
        interceptors=[ErrorInterceptor()],
    )
    # Own queue: a mail backlog never waits behind slow AI work (and the reverse).
    mail_worker = Worker(
        client,
        task_queue=settings.EMAIL_TASK_QUEUE,
        workflows=[SendEmailWorkflow],
        activities=[send_email],
        graceful_shutdown_timeout=timedelta(seconds=10),
        interceptors=[ErrorInterceptor()],
    )
    # Leaving the block finishes in-flight activities, then stops.
    async with worker, mail_worker:
        log.info(
            "worker started (simhash backend: %s, ai contour: %s, summary model: %s,"
            " support: chatwoot %s, tracker %s, triage model %s)",
            backend,
            settings.AI_CONTOUR or "off",
            summary_model or "off",
            "on" if chatwoot else "dry run",
            tracker.name,
            triage_model or "off",
        )
        await stop.wait()
        log.info("shutting down")
    await webhooks.close()
    await http.aclose()
    await s3.close()
    if posthog:
        await posthog.close()
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
