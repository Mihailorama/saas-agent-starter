import asyncio
import logging
import os
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

from worker import flags, pii, settings
from worker.activities import Activities, ModelChoice
from worker.ai import Byo, Gateway, load_registry
from worker.billing import BillingActivities, load_plans
from worker.crm import CrmActivities, Twenty, load_config
from worker.errors import ErrorInterceptor, setup_errors
from worker.log import configure_logging
from worker.mail import send_email
from worker.mcp import McpConfig
from worker.posthog import PostHogAi
from worker.privacy import PrivacyActivities, configured_tools
from worker.providers import load_providers, providers_from_config
from worker.s3 import S3
from worker.support import Chatwoot, SupportActivities
from worker.telegram import Bot, TelegramActivities
from worker.text import backend
from worker.tracker import TrackerActivities
from worker.tracker import connect as tracker_connect
from worker.webhooks import WebhookActivities, parse_keys
from worker.workflows import (
    BillingEventWorkflow,
    CrmSyncWorkflow,
    DataDeletionWorkflow,
    DataExportWorkflow,
    PrivacyRetentionWorkflow,
    ProjectCreatedWorkflow,
    SendEmailWorkflow,
    SupportIssueClosedWorkflow,
    SupportTriageWorkflow,
    TelegramSupportWorkflow,
    TrackerItemWorkflow,
    WebhookEventWorkflow,
    WebhookMaintenanceWorkflow,
    ensure_maintenance_schedule,
    ensure_retention_schedule,
)

log = logging.getLogger("worker")


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
    if os.environ.get("OPENAI_BASE_URL") and not os.environ.get("OPENAI_COMPATIBLE_BASE_URL"):
        # Renamed (docs/deploy.md "Upgrade notes"); unset, the endpoint would silently be off.
        log.error("OPENAI_BASE_URL is no longer read: rename it to OPENAI_COMPATIBLE_BASE_URL")
        raise SystemExit(1)
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
    secret_keys = parse_keys(settings.WEBHOOK_ENCRYPTION_KEYS)
    if settings.AI_CONTOUR:
        await s3.ensure_bucket()
        configs = load_providers(
            settings.AI_MODELS_FILE,
            os.environ,
            cli_url=settings.LLM_CLI_URL,
            cli_token=settings.LLM_CLI_TOKEN,
            timeout=settings.AI_REQUEST_TIMEOUT_SECONDS,
            cli_timeout=settings.AI_CLI_TIMEOUT_SECONDS,
        )
        ai = Gateway(
            pool=pool,
            s3=s3,
            contour=settings.AI_CONTOUR,
            registry=load_registry(settings.AI_MODELS_FILE, settings.AI_CONTOUR),
            providers=providers_from_config(configs),
            provider_configs=configs,
            retention_days=settings.AI_CONTENT_RETENTION_DAYS,
            posthog=posthog,
            plans=plans,
            byo=Byo(secret_keys, [ip_network(c) for c in settings.AI_BYO_ALLOWED_CIDRS])
            if secret_keys
            else None,
            mcp=McpConfig(
                secret_keys,
                [ip_network(c) for c in settings.MCP_ALLOWED_CIDRS],
                settings.MCP_TOOL_MAX_ITERATIONS,
                settings.MCP_TOOL_TIMEOUT_SECONDS,
            )
            if secret_keys
            else None,
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
        encryption_keys=secret_keys,
        max_payload_bytes=settings.WEBHOOK_MAX_PAYLOAD_BYTES,
        disable_after_failures=settings.WEBHOOK_DISABLE_AFTER_FAILURES,
        retention_days=settings.WEBHOOK_RETENTION_DAYS,
    )
    await ensure_maintenance_schedule(client, settings.TEMPORAL_TASK_QUEUE)
    await ensure_retention_schedule(client, settings.TEMPORAL_TASK_QUEUE)
    http = httpx2.AsyncClient(timeout=30)
    files = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.S3_BUCKET,
    )
    privacy_tools = configured_tools(http)
    privacy = PrivacyActivities(
        pool,
        files=files,
        ai_content=s3,
        tools=privacy_tools,
        export_ttl_days=settings.PRIVACY_EXPORT_TTL_DAYS,
        org_records_days=settings.PRIVACY_ORG_RECORDS_DAYS,
        booking_days=settings.BOOKING_PAYLOAD_DAYS,
    )
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
    tracker = await tracker_connect(http)  # refuses a completed/cancelled target state
    tracker_items = TrackerActivities(tracker, files)
    s = settings
    telegram = (
        TelegramActivities(
            bot=Bot(s.TELEGRAM_SUPPORT_BOT_TOKEN, http, s.TELEGRAM_API_URL),
            token=s.TELEGRAM_SUPPORT_BOT_TOKEN,
            chat_id=s.TELEGRAM_SUPPORT_CHAT_ID,
            pool=pool,
            tracker=tracker,
        )
        if s.TELEGRAM_SUPPORT_BOT_TOKEN and s.TELEGRAM_SUPPORT_CHAT_ID
        else None
    )
    if (
        telegram
        and s.TELEGRAM_SUPPORT_WEBHOOK_URL
        and await flags.is_enabled("telegram-support", user_id="telegram")
    ):
        await telegram.register_webhook(s.TELEGRAM_SUPPORT_WEBHOOK_URL)
    support = SupportActivities(
        telegram=telegram,
        chatwoot=chatwoot,
        tracker=tracker,
        ai=ai,
        model=triage_model,
        ai_org_id=settings.SUPPORT_AI_ORG_ID,
        notify=settings.SUPPORT_NOTIFY,
    )
    crm = CrmActivities(
        pool=pool,
        crm=Twenty(settings.TWENTY_API_URL, settings.TWENTY_API_KEY, http)
        if settings.TWENTY_API_URL and settings.TWENTY_API_KEY
        else None,
        config=load_config(settings.CRM_FILE),
        plans=plans,
        chatwoot=chatwoot,
        files=files,
        booking_url=settings.BOOKING_PUBLIC_URL,
    )
    if (chatwoot and triage_model and ai) or telegram:
        await asyncio.to_thread(pii.warm_up)  # triage output and /bug titles: Presidio
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)

    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_TASK_QUEUE,
        workflows=[
            ProjectCreatedWorkflow,
            BillingEventWorkflow,
            CrmSyncWorkflow,
            SupportTriageWorkflow,
            SupportIssueClosedWorkflow,
            TelegramSupportWorkflow,
            TrackerItemWorkflow,
            WebhookEventWorkflow,
            WebhookMaintenanceWorkflow,
            DataExportWorkflow,
            DataDeletionWorkflow,
            PrivacyRetentionWorkflow,
        ],
        activities=[
            activities.fingerprint_project,
            activities.summarize_project,
            billing.apply_billing_event,
            crm.sync,
            support.triage,
            support.issue_closed,
            *([telegram.handle] if telegram else []),
            tracker_items.file_item,
            webhooks.deliver_webhook,
            webhooks.prune_webhooks,
            webhooks.reencrypt_webhook_secrets,
            privacy.build_export,
            privacy.mark_failed,
            privacy.begin_deletion,
            privacy.deletion_step,
            privacy.finish_deletion,
            privacy.purge_ai_content,
            privacy.purge_exports,
            privacy.purge_deleted_orgs,
            privacy.purge_tracker_inbox,
            privacy.purge_booking_payloads,
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
            " support: chatwoot %s, telegram %s, tracker %s, triage model %s, privacy tools: %s,"
            " crm %s)",
            backend,
            settings.AI_CONTOUR or "off",
            summary_model or "off",
            "on" if chatwoot else "dry run",
            "on" if telegram else "off",
            tracker.name,
            triage_model or "off",
            ",".join(t.name for t in privacy_tools.all) or "none",
            crm.crm.name if crm.crm else "dry run",
        )
        await stop.wait()
        log.info("shutting down")
    await webhooks.close()
    await http.aclose()
    await s3.close()
    await files.close()
    if posthog:
        await posthog.close()
    flags.close()
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
