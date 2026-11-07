# Stack

## Resource budget

`docker stats --no-stream` snapshot, 2026-11-06, after ~45 minutes of uptime and a few
sign-up / create-project flows: the whole default stack (built `api`, `worker`, `web`) plus the
`observability` and `glitchtip` profiles, on an 8-core x86_64 Linux host. One-shot containers
(`migrate`, `temporal-setup`, `temporal-namespace`, `glitchtip-db`) have exited and are not
listed. "Limit" is the `mem_limit` in `docker-compose.yml`, set to roughly 1.5-4x the
observed use; raise it when a service is OOM-killed (`docker compose ps` shows exit code 137).

| Service           | Profile       | Memory used (MiB) | Limit (MiB) | CPU (idle) |
| ----------------- | ------------- | ----------------: | ----------: | ---------: |
| postgres          | default       |               147 |         512 |       6.4% |
| redis             | default       |                 6 |          64 |       2.9% |
| mailpit           | default       |                26 |          64 |       4.4% |
| s3 (SeaweedFS)    | default       |                52 |         256 |       5.1% |
| temporal          | default       |               120 |         512 |       5.3% |
| temporal-ui       | default       |                 8 |         128 |       0.0% |
| api               | default       |               142 |         384 |       0.0% |
| worker            | default       |               129 |         384 |       0.1% |
| web (nginx)       | default       |                 8 |          64 |       0.0% |
| otel-collector    | observability |               111 |         384 |       6.1% |
| jaeger            | observability |                30 |         512 |       0.2% |
| prometheus        | observability |               108 |         512 |       1.0% |
| loki              | observability |               116 |         512 |       1.7% |
| grafana           | observability |               305 |         512 |       2.5% |
| glitchtip         | glitchtip     |               182 |         512 |       2.6% |
| chatwoot          | support       |               411 |        1024 |       1.4% |
| chatwoot-sidekiq  | support       |               445 |        1024 |       0.3% |
| chatwoot-postgres | support       |                70 |         512 |       5.5% |

Totals (used / limit): default stack ~612 / 2304 MiB, observability ~670 / 2432 MiB,
GlitchTip ~182 / 512 MiB; everything ~1.46 / 5.1 GiB. Jaeger keeps traces in memory, so its
use grows with traffic until the limit; Prometheus and Loki grow with retention (volumes, not
RAM, for Loki). The permissive twin drops Loki and Grafana (~420 MiB used); Valkey uses about
what Redis does.

The `support` rows (Chatwoot CE, measured 2026-11-07 after start-up, separately from the snapshot
above) peak at ~442 / 572 / 110 MiB under a small load: plan ~1.2 GiB for the profile
(docs/support.md).

Reproduce: `docker compose --profile observability --profile glitchtip up -d --build`, run a
few flows, then
`docker stats --no-stream $(docker compose --profile observability --profile glitchtip ps -q)`.

## LLM-ops tiers (ADR 0009)

- **S tier (one 8 CPU / 24 GB server): PostHog Cloud by default.** Generations, feedback and
  online judges live in PostHog; the stack adds no container and no RAM (the worker posts one
  small HTTP event per LLM call). Promptfoo runs only during `pnpm eval` (a short-lived
  container).
- **Langfuse (`--profile llmops`), optional**, when data must not leave the servers (client
  requirement, RU contour). Measured 2026-11-06 on the same kind of 8 vCPU / 23.5 GiB host,
  `docker stats` after an e2e warm-up (5 runs) and again after a burst of 10,000 spans sent in
  2.7 s (the client queue dropped part of them):

  | Container       | After warm-up, MiB | After the burst, MiB |                  `mem_limit` |
  | --------------- | -----------------: | -------------------: | ---------------------------: |
  | langfuse-web    |                679 |                  701 | 1536 MiB (Node heap 768 MiB) |
  | clickhouse      |                658 |           669 to 690 |                     1536 MiB |
  | langfuse-worker |                455 |                  513 | 1024 MiB (Node heap 768 MiB) |

  Langfuse's share is about **1.8 to 1.9 GiB** (plus about 15 MiB in Postgres for its database);
  the Langfuse worker peaked at about 200 % CPU while ingesting; nothing was OOM-killed. It fits
  a 24 GB box by memory, but Langfuse's own guidance is at least 4 cores / 16 GiB and it calls a
  single-container ClickHouse "development only"; at real traffic give it its own host. Whether
  the S tier runs it at all is an open owner decision (ADR 0009).
