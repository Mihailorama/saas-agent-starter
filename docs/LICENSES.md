# Container image licenses

All application code dependencies are checked automatically against the allowlist
(permissive + MPL-2.0; `pnpm check:licenses`, see [ADR 0005](adr/0005-license-policy.md)).
That allowlist does not apply here: infrastructure runs as separate containers, **run
unmodified, not distributed with the app**, so any license is acceptable, AGPL and
source-available included. Every image must still be listed below; `pnpm check:licenses` fails
on an image that is not. Their primary software licenses:

| Image                          | Used for                                   | License                     |
| ------------------------------ | ------------------------------------------ | --------------------------- |
| `postgres`                     | database (app + Temporal)                  | PostgreSQL                  |
| `redis`                        | rate-limit store                           | RSALv2 / SSPLv1 / AGPLv3    |
| `chrislusf/seaweedfs`          | local S3-compatible storage (dev only)     | Apache-2.0                  |
| `temporalio/server`            | workflow engine                            | MIT                         |
| `temporalio/admin-tools`       | Temporal schema setup, namespace           | MIT                         |
| `temporalio/ui`                | Temporal Web UI                            | MIT                         |
| `otel/opentelemetry-collector` | telemetry pipeline (observability profile) | Apache-2.0                  |
| `jaegertracing/jaeger`         | trace UI (observability profile)           | Apache-2.0                  |
| `prom/prometheus`              | metrics (observability profile)            | Apache-2.0                  |
| `ghcr.io/promptfoo/promptfoo`  | eval engine for `pnpm eval` (eval profile) | MIT                         |
| `langfuse/langfuse`            | Langfuse web (llmops profile)              | MIT core + `ee/` commercial |
| `langfuse/langfuse-worker`     | Langfuse worker (llmops profile)           | MIT core + `ee/` commercial |
| `clickhouse/clickhouse-server` | Langfuse trace store (llmops profile)      | Apache-2.0                  |
| `node`                         | API runtime and web build                  | MIT                         |
| `nginxinc/nginx-unprivileged`  | web static files + `/api` proxy            | BSD-2-Clause                |
| `ghcr.io/astral-sh/uv`         | worker build stage                         | MIT OR Apache-2.0           |
| `python`                       | worker runtime                             | Python-2.0 (PSF)            |

Base OS layers (Alpine, Debian) contain packages under various licenses, including GPL
utilities. They are separate programs in the image, not linked into or distributed as part of
this project's code.

Notes:

- `redis`: Redis 8.0+ is tri-licensed RSALv2 / SSPLv1 / AGPLv3 at your option; 7.2 and earlier
  are BSD-3-Clause ([redis.io/legal/licenses](https://redis.io/legal/licenses/),
  [LICENSE.txt](https://github.com/redis/redis/blob/unstable/LICENSE.txt)). Run unmodified, not
  distributed with the app. Valkey (BSD-3-Clause) is a drop-in replacement if you prefer.
- Object storage is SeaweedFS, not MinIO, because MinIO no longer publishes a community image
  (checked 2026-11-05): [github.com/minio/minio](https://github.com/minio/minio) is archived and
  says "THIS REPOSITORY IS NO LONGER MAINTAINED" and "The MinIO community edition is now
  distributed as source code only"; the last [release](https://github.com/minio/minio/releases)
  is `RELEASE.2025-10-15T17-29-55Z` (2025-10-16); `hub.docker.com/r/minio/minio` returns 404.
  Details in [ADR 0007](adr/0007-infrastructure.md).
- The observability profile will add Grafana and Loki (AGPL-3.0) in a later change.
- `ghcr.io/promptfoo/promptfoo`: Promptfoo itself is MIT, but its npm dependency tree is not
  (checked 2026-11-06 with `promptfoo@0.125.1`: `@img/sharp-libvips-*` LGPL-3.0-or-later,
  `binaryextensions`/`istextorbinary`/... Artistic-2.0, `sylvester` unknown), so it would fail
  the code-dependency gate. It runs as an unmodified dev-tool container instead
  ([ADR 0009](adr/0009-llm-ops.md)).
- `langfuse/*`: MIT for everything outside the `ee/` directories, which are under a commercial
  license and only active with a license key. Everything this repo uses (OTLP ingestion,
  scores, prompt management) is in the MIT core
  ([LICENSE](https://github.com/langfuse/langfuse/blob/main/LICENSE),
  [license key](https://langfuse.com/self-hosting/license-key)). The browser SDK `langfuse`
  (npm, MIT) is a code dependency and goes through the gate like any other.
