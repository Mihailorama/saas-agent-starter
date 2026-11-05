# Container image licenses

All application code dependencies are checked automatically (`pnpm check:licenses`, see
[ADR 0005](adr/0005-license-policy.md)). Infrastructure runs as separate, unmodified
containers; their primary software licenses:

| Image                          | Used for                                   | License           |
| ------------------------------ | ------------------------------------------ | ----------------- |
| `postgres`                     | database (app + Temporal)                  | PostgreSQL        |
| `valkey/valkey`                | rate-limit store (Redis-compatible)        | BSD-3-Clause      |
| `chrislusf/seaweedfs`          | local S3-compatible storage (dev only)     | Apache-2.0        |
| `temporalio/server`            | workflow engine                            | MIT               |
| `temporalio/admin-tools`       | Temporal schema setup, namespace           | MIT               |
| `temporalio/ui`                | Temporal Web UI                            | MIT               |
| `otel/opentelemetry-collector` | telemetry pipeline (observability profile) | Apache-2.0        |
| `jaegertracing/jaeger`         | trace UI (observability profile)           | Apache-2.0        |
| `prom/prometheus`              | metrics (observability profile)            | Apache-2.0        |
| `node`                         | API runtime and web build                  | MIT               |
| `nginxinc/nginx-unprivileged`  | web static files + `/api` proxy            | BSD-2-Clause      |
| `ghcr.io/astral-sh/uv`         | worker build stage                         | MIT OR Apache-2.0 |
| `python`                       | worker runtime                             | Python-2.0 (PSF)  |

Base OS layers (Alpine, Debian) contain packages under various licenses, including GPL
utilities. They are separate programs in the image, not linked into or distributed as part of
this project's code. Grafana (AGPL-3.0) is optional and not included.
