# 0007. Cache, object storage, observability

Status: accepted

## Decision

- Redis (official `redis` image, mainstream) via `ioredis`, used only as the shared rate-limit
  store. Redis 8 is tri-licensed RSALv2/SSPLv1/AGPLv3; that is fine for an infrastructure
  container we run unmodified and do not distribute with the app (ADR 0005). Valkey stays a
  drop-in alternative: same protocol, same `REDIS_URL`. No session cache: sessions are a cheap indexed Postgres lookup.
- Object storage through the AWS S3 SDK with an env endpoint, so AWS S3, Cloudflare R2, MinIO or
  SeaweedFS all work. Uploads and downloads use short-lived presigned URLs; the API never proxies
  file bytes. Local dev runs SeaweedFS (Apache-2.0), not MinIO: MinIO's community edition is no
  longer published as an image or binary (checked 2026-11-05). The
  [minio/minio repository](https://github.com/minio/minio) is archived (April 2026) and its
  README says "THIS REPOSITORY IS NO LONGER MAINTAINED" and "The MinIO community edition is now
  distributed as source code only"; the last
  [release](https://github.com/minio/minio/releases) is `RELEASE.2025-10-15T17-29-55Z`, and
  [hub.docker.com/r/minio/minio](https://hub.docker.com/r/minio/minio) returns 404. The
  maintained successor, AIStor, is proprietary. Its license would be acceptable for an infra
  container, but an unmaintained or self-built image is not a sane default. Revisit if MinIO
  publishes community images again.
- OpenTelemetry in the API (HTTP, Fastify, pg, ioredis instrumentation), the Python worker and
  the Temporal SDK interceptors; export via OTLP. The `observability` compose profile runs the
  OTel Collector, Jaeger (traces) and Prometheus (metrics, also scraping the Temporal server).
  Grafana and Loki (dashboards, logs) will join the profile in a later change.
