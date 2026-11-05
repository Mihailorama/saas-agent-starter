import asyncio
import logging
import signal
from datetime import timedelta

import asyncpg
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from temporalio.client import Client
from temporalio.contrib.opentelemetry import TracingInterceptor
from temporalio.worker import Worker

from worker import settings
from worker.activities import Activities
from worker.log import configure_logging
from worker.text import backend
from worker.workflows import ProjectCreatedWorkflow

log = logging.getLogger("worker")


def setup_tracing() -> None:
    if not settings.OTEL_ENDPOINT:
        return
    provider = TracerProvider(resource=Resource.create({"service.name": "worker"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)


async def main() -> None:
    configure_logging()
    setup_tracing()
    client = await Client.connect(
        settings.TEMPORAL_ADDRESS,
        namespace=settings.TEMPORAL_NAMESPACE,
        interceptors=[TracingInterceptor()],
    )
    pool = await asyncpg.create_pool(settings.DATABASE_URL)
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)

    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_TASK_QUEUE,
        workflows=[ProjectCreatedWorkflow],
        activities=[Activities(pool).fingerprint_project],
        graceful_shutdown_timeout=timedelta(seconds=10),
    )
    async with worker:  # leaving the block finishes in-flight activities, then stops
        log.info("worker started (simhash backend: %s)", backend)
        await stop.wait()
        log.info("shutting down")
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
