# Container image licenses

All application code dependencies are checked automatically against the allowlist
(permissive + MPL-2.0; `pnpm check:licenses`, see [ADR 0005](adr/0005-license-policy.md)).
That allowlist does not apply here: infrastructure runs as separate containers, **run
unmodified, not distributed with the app**, so any license is acceptable, AGPL and
source-available included. Every image must still be listed below; `pnpm check:licenses` fails
on an image that is not. Their primary software licenses:

| Image                                  | Used for                                           | License                     |
| -------------------------------------- | -------------------------------------------------- | --------------------------- |
| `postgres`                             | database (app + Temporal)                          | PostgreSQL                  |
| `redis`                                | rate-limit store                                   | RSALv2 / SSPLv1 / AGPLv3    |
| `valkey/valkey`                        | rate-limit store (permissive twin)                 | BSD-3-Clause                |
| `chrislusf/seaweedfs`                  | local S3-compatible storage (dev only)             | Apache-2.0                  |
| `temporalio/server`                    | workflow engine                                    | MIT                         |
| `temporalio/admin-tools`               | Temporal schema setup, namespace                   | MIT                         |
| `temporalio/ui`                        | Temporal Web UI                                    | MIT                         |
| `otel/opentelemetry-collector-contrib` | telemetry pipeline, container logs (observability) | Apache-2.0                  |
| `jaegertracing/jaeger`                 | traces (observability profile)                     | Apache-2.0                  |
| `prom/prometheus`                      | metrics, alert rules (observability)               | Apache-2.0                  |
| `grafana/loki`                         | logs (observability profile)                       | AGPL-3.0                    |
| `grafana/grafana`                      | dashboards, single pane (observability)            | AGPL-3.0                    |
| `glitchtip/glitchtip`                  | error tracking, Sentry API (glitchtip profile)     | MIT                         |
| `node`                                 | API runtime and web build                          | MIT                         |
| `nginxinc/nginx-unprivileged`          | web static files + `/api` proxy                    | BSD-2-Clause                |
| `caddy`                                | TLS + ingress in `compose.prod.yaml` (ADR 0016)    | Apache-2.0                  |
| `ghcr.io/astral-sh/uv`                 | worker build stage                                 | MIT OR Apache-2.0           |
| `python`                               | worker runtime                                     | Python-2.0 (PSF)            |
| `ghcr.io/umami-software/umami`         | product analytics (`analytics` profile)            | MIT                         |
| `axllent/mailpit`                      | catches outgoing mail in dev (UI/API :8025)        | MIT                         |
| `ghcr.io/promptfoo/promptfoo`          | eval engine for `pnpm eval` (eval profile)         | MIT                         |
| `langfuse/langfuse`                    | Langfuse web (llmops profile)                      | MIT core + `ee/` commercial |
| `langfuse/langfuse-worker`             | Langfuse worker (llmops profile)                   | MIT core + `ee/` commercial |
| `clickhouse/clickhouse-server`         | Langfuse trace store (llmops profile)              | Apache-2.0                  |
| `chatwoot/chatwoot`                    | service desk, `-ce` tag only (`support` profile)   | MIT                         |
| `pgvector/pgvector`                    | Chatwoot's database (`support` profile)            | PostgreSQL                  |
| `stripe/stripe-mock`                   | Stripe API mock for tests/dev (`billing` profile)  | MIT                         |

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
- `ghcr.io/promptfoo/promptfoo`: Promptfoo itself is MIT, but its npm dependency tree is not
  (checked 2026-11-06 with `promptfoo@0.125.1`: `@img/sharp-libvips-*` LGPL-3.0-or-later,
  `binaryextensions`/`istextorbinary`/... Artistic-2.0, `sylvester` unknown), so it would fail
  the code-dependency gate. It runs as an unmodified dev-tool container instead
  ([ADR 0009](adr/0009-llm-ops.md)).
- `langfuse/*`: MIT for everything outside the `ee/` directories, which are under a commercial
  license and only active with a license key. Everything this repo uses (OTLP ingestion,
  scores, prompt management) is in the MIT core
  ([LICENSE](https://github.com/langfuse/langfuse/blob/main/LICENSE),
  [license key](https://langfuse.com/self-hosting/license-key)).
- Feature-flag code dependencies ([docs/feature-flags.md](feature-flags.md), checked by the gate):
  `posthog-node` (MIT, API); `posthog-js` (above) in the web. The worker calls PostHog's `/flags`
  HTTP API with the existing `httpx2`: the `posthog` PyPI SDK (MIT) depends on `distro`, whose
  metadata says "Apache License, Version 2.0", a string the gate does not map to `Apache-2.0`.
- GitHub Actions for releases ([docs/releases.md](releases.md)), CI tooling, not shipped and not
  scanned by the gate, pinned by commit SHA: `googleapis/release-please-action` v5.0.0
  ([Apache-2.0](https://github.com/googleapis/release-please-action/blob/main/LICENSE)) and
  `amannn/action-semantic-pull-request` v6.1.1
  ([MIT](https://github.com/amannn/action-semantic-pull-request/blob/main/LICENSE)).

- `axllent/mailpit` ([MIT](https://github.com/axllent/mailpit/blob/develop/LICENSE)): local
  SMTP catcher for transactional email, see [docs/email.md](email.md). Production sends through
  a provider over SMTP instead. Email code dependencies: `@react-email/render` (MIT; React
  Email's renderer, `react`/`react-dom` MIT); the worker sends with Python's standard
  `smtplib`, no package.
- Two-factor and passkey code dependencies ([ADR 0017](adr/0017-two-factor-and-passkeys.md)),
  checked by the gate like every npm package: `@better-auth/passkey` (MIT) with
  `@simplewebauthn/server` and `@simplewebauthn/browser` (MIT; the server's transitive deps are
  `@peculiar/*`, `@hexagon/base64`, `@levischuck/tiny-cbor`, `pvtsutils`, `tsyringe` (MIT),
  `asn1js` (BSD-3-Clause), `reflect-metadata` (Apache-2.0), `tslib` 1.x (0BSD)), `qrcode.react`
  (ISC) for the enrolment QR code, and `otpauth` (MIT, tests only) to generate TOTP codes. The
  TOTP plugin itself ships inside `better-auth` (MIT).

- Public API and webhooks (ADR 0018) add no container. Code dependencies, checked by the gate:
  `@better-auth/api-key` (MIT); in the worker, the official Standard Webhooks library
  `standardwebhooks` (PyPI, MIT, no dependencies), which signs deliveries, and `cryptography`
  (Apache-2.0 OR BSD-3-Clause; with `cffi` MIT-0 and `pycparser` BSD-3-Clause), which decrypts
  the signing secrets. Self-hosted Svix (`svix/svix-server`, MIT) was evaluated and not added:
  its open-source edition has no customer app portal.
- `chatwoot/chatwoot` (service desk, [docs/support.md](support.md)): the repository's
  [LICENSE](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE) puts everything outside
  `enterprise/` under MIT (Expat) and `enterprise/` under its own license (`enterprise/LICENSE`).
  We run only the `-ce` tag (`v4.19.1-ce`), which Chatwoot's
  [publish_foss_docker.yml](https://github.com/chatwoot/chatwoot/blob/develop/.github/workflows/publish_foss_docker.yml)
  builds after `rm -rf enterprise`, so no enterprise code is in the image and none of its
  features (Captain AI, SLA, custom roles, audit logs) are used. The plain `vX.Y.Z` tag
  contains `enterprise/`: do not switch to it. Chatwoot Cloud is an external service, not shipped.
- `pgvector/pgvector`: the official Postgres image plus the pgvector extension (PostgreSQL
  License, [LICENSE](https://github.com/pgvector/pgvector/blob/master/LICENSE)). Chatwoot's schema
  enables `vector`, which `postgres:17-alpine` does not ship, so Chatwoot gets this server.
- `stripe/stripe-mock` ([MIT](https://github.com/stripe/stripe-mock/blob/master/LICENSE),
  Stripe's official API mock, v0.206.0, checked 2026-11-07): tests and local development only,
  never deployed. Billing code dependency: `stripe` (official Node SDK, MIT, no runtime
  dependencies). Details in [docs/billing.md](billing.md).

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
