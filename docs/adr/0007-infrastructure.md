# 0007. Cache, object storage, observability

Status: accepted

## Decision

- Valkey (BSD-3, Linux Foundation fork of Redis 7.2, Redis protocol) via `ioredis`, used only as
  the shared rate-limit store. No session cache: sessions are a cheap indexed Postgres lookup.
- Object storage through the AWS S3 SDK with an env endpoint, so AWS S3, Cloudflare R2, MinIO or
  SeaweedFS all work. Uploads and downloads use short-lived presigned URLs; the API never proxies
  file bytes. Local dev runs SeaweedFS (Apache-2.0): the MinIO community repository is
  archived and distributed as source only (no current official images), and MinIO is AGPL.
- OpenTelemetry in the API (HTTP, Fastify, pg, ioredis instrumentation), the Python worker and
  the Temporal SDK interceptors; export via OTLP. The `observability` compose profile runs the
  OTel Collector, Jaeger (traces) and Prometheus (metrics, also scraping the Temporal server).
  Grafana is AGPL and optional; point it at Prometheus/Jaeger if you want dashboards.
