import asyncio
import logging
import signal
from datetime import timedelta

import asyncpg
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import set_meter_provider
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
from worker.billing import BillingActivities, YooKassa, load_plans
from worker.errors import ErrorInterceptor, setup_errors
from worker.log import configure_logging
from worker.s3 import S3
from worker.text import backend
from worker.workflows import (
    BillingEventWorkflow,
    ProjectCreatedWorkflow,
    SubscriptionRenewalWorkflow,
)

log = logging.getLogger("worker")


def setup_tracing() -> Runtime | None:
    """Traces via the OTel SDK; Temporal SDK metrics (temporal_*) via the Core runtime."""
    if not settings.OTEL_ENDPOINT:
        return None
    resource = Resource.create({"service.name": "worker"})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    # App metrics (billing_llm_* today); Temporal's own temporal_* metrics come from the runtime.
    reader = PeriodicExportingMetricReader(OTLPMetricExporter())
    set_meter_provider(MeterProvider(resource=resource, metric_readers=[reader]))
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
            plans=plans,
        )
    summary_model = (
        ModelChoice(settings.AI_PROJECT_SUMMARY_PROVIDER, settings.AI_PROJECT_SUMMARY_MODEL)
        if settings.AI_PROJECT_SUMMARY_PROVIDER and settings.AI_PROJECT_SUMMARY_MODEL
        else None
    )
    activities = Activities(pool, ai, summary_model)
    yookassa = (
        YooKassa(settings.YOOKASSA_SHOP_ID, settings.YOOKASSA_SECRET_KEY, settings.YOOKASSA_API_URL)
        if settings.YOOKASSA_SHOP_ID and settings.YOOKASSA_SECRET_KEY
        else None
    )
    billing = BillingActivities(pool, plans, yookassa)
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)

    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_TASK_QUEUE,
        workflows=[ProjectCreatedWorkflow, BillingEventWorkflow, SubscriptionRenewalWorkflow],
        activities=[
            activities.fingerprint_project,
            activities.summarize_project,
            billing.apply_billing_event,
            billing.charge_renewal,
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
    await s3.close()
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
