import asyncio
import logging
import signal
from datetime import timedelta

import asyncpg
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleSpec,
    ScheduleUpdate,
    ScheduleUpdateInput,
)
from temporalio.contrib.opentelemetry import TracingInterceptor
from temporalio.worker import Worker

from worker import settings
from worker.activities import Activities, ModelChoice
from worker.ai import PROVIDERS, Gateway, load_registry
from worker.judge import DriftCheck, JudgeActivities, JudgeChoice
from worker.log import configure_logging
from worker.s3 import S3
from worker.text import backend
from worker.workflows import DriftCheckWorkflow, ProjectCreatedWorkflow

log = logging.getLogger("worker")


def setup_telemetry() -> None:
    resource = Resource.create({"service.name": "worker"})
    if settings.OTEL_ENDPOINT or settings.OTEL_TRACES_ENDPOINT:
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        trace.set_tracer_provider(provider)
    if settings.OTEL_ENDPOINT:  # metrics need a metrics backend (collector -> Prometheus)
        reader = PeriodicExportingMetricReader(OTLPMetricExporter())
        metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[reader]))


async def ensure_drift_schedule(client: Client) -> None:
    """Creates or updates the `ai-drift-check` schedule (AI_DRIFT_CRON, UTC)."""
    schedule = Schedule(
        action=ScheduleActionStartWorkflow(
            DriftCheckWorkflow.run,
            DriftCheck(settings.AI_DRIFT_SAMPLE, settings.AI_DRIFT_LOOKBACK_HOURS),
            id="ai-drift-check",
            task_queue=settings.TEMPORAL_TASK_QUEUE,
        ),
        spec=ScheduleSpec(cron_expressions=[settings.AI_DRIFT_CRON]),
    )
    try:
        await client.create_schedule("ai-drift-check", schedule)
    except ScheduleAlreadyRunningError:

        def update(_: ScheduleUpdateInput) -> ScheduleUpdate:
            return ScheduleUpdate(schedule=schedule)

        await client.get_schedule_handle("ai-drift-check").update(update)


async def main() -> None:
    configure_logging()
    setup_telemetry()
    client = await Client.connect(
        settings.TEMPORAL_ADDRESS,
        namespace=settings.TEMPORAL_NAMESPACE,
        interceptors=[TracingInterceptor()],
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
    judge = (
        JudgeChoice(settings.AI_JUDGE_PROVIDER, settings.AI_JUDGE_MODEL)
        if ai and settings.AI_JUDGE_PROVIDER and settings.AI_JUDGE_MODEL
        else None
    )
    judging = JudgeActivities(pool, ai, judge)
    if judge:
        await ensure_drift_schedule(client)
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)

    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_TASK_QUEUE,
        workflows=[ProjectCreatedWorkflow, DriftCheckWorkflow],
        activities=[
            activities.fingerprint_project,
            activities.summarize_project,
            judging.sample_for_drift,
            judging.judge_call,
        ],
        graceful_shutdown_timeout=timedelta(seconds=10),
    )
    async with worker:  # leaving the block finishes in-flight activities, then stops
        log.info(
            "worker started (simhash backend: %s, ai contour: %s, summary model: %s, judge: %s)",
            backend,
            settings.AI_CONTOUR or "off",
            summary_model or "off",
            judge or "off",
        )
        await stop.wait()
        log.info("shutting down")
    await s3.close()
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
