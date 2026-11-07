import asyncio
import logging
import signal
from datetime import timedelta
from ipaddress import ip_network

import asyncpg
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
from worker.text import backend
from worker.webhooks import WebhookActivities
from worker.workflows import ProjectCreatedWorkflow, WebhookEventWorkflow

log = logging.getLogger("worker")


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
    webhooks = WebhookActivities(
        pool,
        allowed_networks=[ip_network(c) for c in settings.WEBHOOK_ALLOWED_CIDRS],
        max_payload_bytes=settings.WEBHOOK_MAX_PAYLOAD_BYTES,
    )
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)

    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_TASK_QUEUE,
        workflows=[ProjectCreatedWorkflow, WebhookEventWorkflow],
        activities=[
            activities.fingerprint_project,
            activities.summarize_project,
            webhooks.deliver_webhook,
        ],
        graceful_shutdown_timeout=timedelta(seconds=10),
        interceptors=[ErrorInterceptor()],
    )
    async with worker:  # leaving the block finishes in-flight activities, then stops
        log.info(
            "worker started (simhash backend: %s, ai contour: %s, summary model: %s)",
            backend,
            settings.AI_CONTOUR or "off",
            summary_model or "off",
        )
        await stop.wait()
        log.info("shutting down")
    await webhooks.close()
    await s3.close()
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
