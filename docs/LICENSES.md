# Container image licenses

All application code dependencies are checked automatically against the allowlist
(permissive + MPL-2.0; `pnpm check:licenses`, see [ADR 0005](adr/0005-license-policy.md)).
That allowlist does not apply here: infrastructure runs as separate containers, **run
unmodified, not distributed with the app**, so any license is acceptable, AGPL and
source-available included. Every image must still be listed below; `pnpm check:licenses` fails
on an image that is not. Their primary software licenses:

| Image                                  | Used for                                           | License                  |
| -------------------------------------- | -------------------------------------------------- | ------------------------ |
| `postgres`                             | database (app + Temporal)                          | PostgreSQL               |
| `redis`                                | rate-limit store                                   | RSALv2 / SSPLv1 / AGPLv3 |
| `valkey/valkey`                        | rate-limit store (permissive twin)                 | BSD-3-Clause             |
| `chrislusf/seaweedfs`                  | local S3-compatible storage (dev only)             | Apache-2.0               |
| `temporalio/server`                    | workflow engine                                    | MIT                      |
| `temporalio/admin-tools`               | Temporal schema setup, namespace                   | MIT                      |
| `temporalio/ui`                        | Temporal Web UI                                    | MIT                      |
| `otel/opentelemetry-collector-contrib` | telemetry pipeline, container logs (observability) | Apache-2.0               |
| `jaegertracing/jaeger`                 | traces (observability profile)                     | Apache-2.0               |
| `prom/prometheus`                      | metrics, alert rules (observability)               | Apache-2.0               |
| `grafana/loki`                         | logs (observability profile)                       | AGPL-3.0                 |
| `grafana/grafana`                      | dashboards, single pane (observability)            | AGPL-3.0                 |
| `glitchtip/glitchtip`                  | error tracking, Sentry API (glitchtip profile)     | MIT                      |
| `node`                                 | API runtime and web build                          | MIT                      |
| `nginxinc/nginx-unprivileged`          | web static files + `/api` proxy                    | BSD-2-Clause             |
| `caddy`                                | TLS + ingress in `compose.prod.yaml` (ADR 0016)    | Apache-2.0               |
| `ghcr.io/astral-sh/uv`                 | worker build stage                                 | MIT OR Apache-2.0        |
| `python`                               | worker runtime                                     | Python-2.0 (PSF)         |
| `ghcr.io/umami-software/umami`         | product analytics (`analytics` profile)            | MIT                      |

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
- Grafana and Loki are AGPL-3.0 ([grafana LICENSE](https://github.com/grafana/grafana/blob/main/LICENSE),
  [loki LICENSE](https://github.com/grafana/loki/blob/main/LICENSE)). Run unmodified, not
  distributed with the app; for deliveries that ban AGPL use the permissive twin below.
- GlitchTip is MIT ([LICENSE](https://gitlab.com/glitchtip/glitchtip-backend/-/blob/master/LICENSE)).
- Sentry (server, and its self-hosted package) is FSL-1.1-Apache-2.0, a source-available license
  that converts to Apache-2.0 two years after each release
  ([sentry LICENSE.md](https://github.com/getsentry/sentry/blob/master/LICENSE.md),
  [self-hosted LICENSE.md](https://github.com/getsentry/self-hosted/blob/master/LICENSE.md)). It
  is not in compose; use it as SaaS or self-host it from its own repository. The Sentry SDKs we
  use are MIT (`@sentry/react`, `@sentry/node-core`, `sentry-sdk`). `@sentry/node` 11 is not
  used: it depends on the `sentry` CLI package (FSL-1.1-Apache-2.0), which the code license gate
  rejects.
- Tooling, not part of the stack: `anchore/syft` (Apache-2.0) generates the SBOMs (`pnpm run sbom`).
- Deploy tooling on the operator machine or CI runner, not part of the stack or the images:
  [SOPS](https://github.com/getsops/sops) (MPL-2.0, run unmodified as a CLI) and
  [age](https://github.com/FiloSottile/age) (BSD-3-Clause) for the encrypted env files
  (docs/deploy.md).
- `caddy` is Apache-2.0 ([LICENSE](https://github.com/caddyserver/caddy/blob/master/LICENSE)),
  already permissive: the production stack needs no twin for it.

- `ghcr.io/umami-software/umami` (Umami 3, [MIT](https://github.com/umami-software/umami/blob/master/LICENSE)):
  self-hosted product analytics, see [docs/product-analytics.md](product-analytics.md). For an
  on-prem delivery MIT only asks to keep the copyright notice, which the image already carries;
  the client may run, copy and modify it freely. Its `umami-db` one-shot helper reuses the
  `postgres` image.
- Product-analytics code dependencies (checked by the gate like every npm package):
  `posthog-js` is `Apache-2.0 AND MIT` (both permissive; ship the notices), `@langfuse/browser`
  is MIT. PostHog Cloud, GA4 and Yandex Metrika are external services, not shipped software:
  an on-prem client gets none of them unless it sets their env vars.

## Permissive twin (replacement map)

Some enterprise clients ban AGPL (or any non-permissive license) in on-premises deliveries,
even for unmodified separate containers. Every non-permissive container has a permissive twin;
the app code and config do not change, only the compose files:

```sh
docker compose -f docker-compose.yml -f compose.permissive.yaml --profile observability up -d
# or once: COMPOSE_FILE=docker-compose.yml:compose.permissive.yaml in .env
```

| Component            | Default (license)                          | Permissive twin (license)                                                                 | What you lose                                                                                                                                                                                          |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rate-limit store     | Redis 8 (RSALv2/SSPLv1/AGPLv3)             | Valkey 9 (BSD-3-Clause), same protocol and `REDIS_URL`                                    | Nothing the app uses. Redis-only modules/features (e.g. Redis Query Engine) are not in Valkey.                                                                                                         |
| Logs                 | Loki (AGPL-3.0)                            | none: `docker compose logs`, or ship the collector's logs to any OTLP backend you license | Central log search, log-to-trace links, log retention. The collector still runs; its Loki log pipeline is dropped.                                                                                     |
| Dashboards/alerts UI | Grafana (AGPL-3.0)                         | Prometheus UI (graphs, `/alerts`) + Jaeger UI (traces), both Apache-2.0                   | Provisioned dashboards, one pane across logs/metrics/traces, Grafana alerting UI. Alert rules still evaluate in Prometheus (`infra/otel/alerts.yml`); add Alertmanager (Apache-2.0) for notifications. |
| Error tracking       | GlitchTip (MIT), already permissive        | (Sentry SaaS / self-hosted is FSL: a bigger, not a more permissive, option)               | n/a                                                                                                                                                                                                    |
| Object storage       | SeaweedFS (Apache-2.0), already permissive | n/a                                                                                       | n/a                                                                                                                                                                                                    |

SBOMs and notices for a delivery: `pnpm run sbom` writes one CycloneDX SBOM per image (both
twins, all profiles) and `THIRD_PARTY_NOTICES.md` to `dist/sbom/` (also a CI artifact on
`v*` tags).
