// @sentry/node-core, not @sentry/node: @sentry/node 11 depends on the Sentry CLI (FSL, banned by
// ADR 0005), and its Fastify integration registers a second @fastify/otel next to ours. app.ts
// reports errors in an onError hook. Error reporting over the Sentry protocol (Sentry SaaS/self-hosted or GlitchTip: only the DSN
// differs). Preloaded from telemetry.ts; a no-op unless SENTRY_DSN is set. Errors only, no
// Sentry tracing: traces stay in OpenTelemetry, and each event carries the OTel trace_id.
import { trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/node-core';

/** URL without query string or path token (password reset links): what logs and traces keep. */
export const redactUrl = (url: string) =>
  url.split('?')[0]!.replace(/\/reset-password\/[^/]+/, '/reset-password/:token');

/** Drops anything that can carry PII, secrets or AI content; keeps the stack and ids. */
export function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    event.request = {
      method: event.request.method,
      url: event.request.url && redactUrl(event.request.url),
    };
  }
  delete event.user;
  delete event.extra;
  for (const b of event.breadcrumbs ?? []) {
    if (typeof b.data?.url === 'string') b.data.url = redactUrl(b.data.url);
  }
  const ctx = trace.getActiveSpan()?.spanContext();
  if (ctx) {
    event.tags = { ...event.tags, trace_id: ctx.traceId };
    event.contexts = {
      ...event.contexts,
      trace: { trace_id: ctx.traceId, span_id: ctx.spanId },
    };
  }
  return event;
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
    sendDefaultPii: false,
    includeLocalVariables: false,
    beforeSend: scrub,
    beforeBreadcrumb: (b) => (b.category === 'console' ? null : b), // log text stays in Loki
  });
}
