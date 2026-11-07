# Stack

## Resource budget

`docker stats --no-stream` snapshot, 2026-11-06, after ~45 minutes of uptime and a few
sign-up / create-project flows: the whole default stack (built `api`, `worker`, `web`) plus the
`observability` and `glitchtip` profiles, on an 8-core x86_64 Linux host. One-shot containers
(`migrate`, `temporal-setup`, `temporal-namespace`, `glitchtip-db`) have exited and are not
listed. "Limit" is the `mem_limit` in `docker-compose.yml`, set to roughly 1.5-4x the
observed use; raise it when a service is OOM-killed (`docker compose ps` shows exit code 137).

| Service        | Profile       | Memory used (MiB) | Limit (MiB) | CPU (idle) |
| -------------- | ------------- | ----------------: | ----------: | ---------: |
| postgres       | default       |               147 |         512 |       6.4% |
| redis          | default       |                 6 |          64 |       2.9% |
| mailpit        | default       |                26 |          64 |       4.4% |
| s3 (SeaweedFS) | default       |                52 |         256 |       5.1% |
| temporal       | default       |               120 |         512 |       5.3% |
| temporal-ui    | default       |                 8 |         128 |       0.0% |
| api            | default       |               142 |         384 |       0.0% |
| worker         | default       |               129 |         384 |       0.1% |
| web (nginx)    | default       |                 8 |          64 |       0.0% |
| otel-collector | observability |               111 |         384 |       6.1% |
| jaeger         | observability |                30 |         512 |       0.2% |
| prometheus     | observability |               108 |         512 |       1.0% |
| loki           | observability |               116 |         512 |       1.7% |
| grafana        | observability |               305 |         512 |       2.5% |
| glitchtip      | glitchtip     |               182 |         512 |       2.6% |
| site (nginx)   | marketing     |                 7 |          64 |       0.0% |
| postiz         | marketing     |             1,264 |        2048 |       ~20% |
| serpbear       | marketing     |                71 |         512 |       0.0% |

Totals (used / limit): default stack ~612 / 2304 MiB, observability ~670 / 2432 MiB,
GlitchTip ~182 / 512 MiB; everything ~1.46 / 5.1 GiB. Jaeger keeps traces in memory, so its
use grows with traffic until the limit; Prometheus and Loki grow with retention (volumes, not
RAM, for Loki). The permissive twin drops Loki and Grafana (~420 MiB used); Valkey uses about
what Redis does.

Marketing profile (2026-11-07, separate run, docs/marketing.md): `site`, Postiz v2.25.3 and
SerpBear 3.1.2 on postgres, redis and temporal only. Postiz 1,264 MiB is idle 3 minutes after a
restart with no traffic (1,381 MiB after a smoke test: register, one draft); its idle CPU stays at
18-28 % of one core. SerpBear 71 MiB idle, 176 MiB after its smoke test (login, domain, keyword).
Postiz's Temporal workers raise `temporal` to ~228 MiB and Postgres grows ~25 MiB; Redis is
unchanged. Marketing profile ~1.3 / 2.6 GiB (used / limit) on top of the shared services.

Reproduce: `docker compose --profile observability --profile glitchtip up -d --build`, run a
few flows, then
`docker stats --no-stream $(docker compose --profile observability --profile glitchtip ps -q)`.
