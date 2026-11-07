import asyncio
import logging
import signal
from datetime import timedelta

import asyncpg
import httpx2
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
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
from worker.errors import ErrorInterceptor, setup_errors
from worker.log import configure_logging
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
from worker.workflows import (
    ProjectCreatedWorkflow,
    SupportIssueClosedWorkflow,
    SupportTriageWorkflow,
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
    """Traces via the OTel SDK; Temporal SDK metrics (temporal_*) via the Core runtime."""
    if not settings.OTEL_ENDPOINT:
        return None
    provider = TracerProvider(resource=Resource.create({"service.name": "worker"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    metrics = OpenTelemetryConfig(
        url=f"{settings.OTEL_ENDPOINT}/v1/metrics", http=True, durations_as_seconds=True
    )
    return Runtime(telemetry=TelemetryConfig(metrics=metrics))


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
        )
    summary_model = (
        ModelChoice(settings.AI_PROJECT_SUMMARY_PROVIDER, settings.AI_PROJECT_SUMMARY_MODEL)
        if settings.AI_PROJECT_SUMMARY_PROVIDER and settings.AI_PROJECT_SUMMARY_MODEL
        else None
    )
    activities = Activities(pool, ai, summary_model)
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
        notify_on_close=settings.SUPPORT_NOTIFY_ON_CLOSE,
    )
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)

    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_TASK_QUEUE,
        workflows=[ProjectCreatedWorkflow, SupportTriageWorkflow, SupportIssueClosedWorkflow],
        activities=[
            activities.fingerprint_project,
            activities.summarize_project,
            support.triage,
            support.issue_closed,
        ],
        graceful_shutdown_timeout=timedelta(seconds=10),
        interceptors=[ErrorInterceptor()],
    )
    async with worker:  # leaving the block finishes in-flight activities, then stops
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
    await http.aclose()
    await s3.close()
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
