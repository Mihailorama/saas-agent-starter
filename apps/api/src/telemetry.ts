// Preloaded with `node --import ./src/telemetry.ts` so instrumentation patches
// modules before they load. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { register } from 'node:module';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  register('import-in-the-middle/hook.mjs', import.meta.url);
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
  const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
  const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http');
  const { PgInstrumentation } = await import('@opentelemetry/instrumentation-pg');
  const { IORedisInstrumentation } = await import('@opentelemetry/instrumentation-ioredis');
  const { default: FastifyOtel } = await import('@fastify/otel');

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'api',
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    instrumentations: [
      new HttpInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
      new FastifyOtel.FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });
  sdk.start();
  process.once('beforeExit', () => sdk.shutdown());
}
