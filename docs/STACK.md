# Stack footprint on one server

Measured 2026-11-06 on an 8 vCPU / 23.5 GiB Linux VM (kernel 6.8, Docker 29.6), shared with
unrelated containers, compose project with all app services in containers
(`docker compose up -d --build`). Warm-up: the Playwright smoke (sign up, create org, create
project, LLM Ops page, transparency page) run 3 times against the containerized web/API (5 times
for Full), then `docker stats --no-stream` after 1 to 3 minutes idle. Numbers are `docker stats`
MEM USAGE (cgroup memory without inactive page cache). No LLM key was set, so no model was
called; the worker still exported its Temporal spans. Not measured: real LLM traffic, many
concurrent users, Langfuse UI sessions, ClickHouse merges after weeks of data. Treat the numbers
as a floor, and keep the limits below as the budget.

## Lite (default, no LLM-ops services)

| Container   |     MiB |
| ----------- | ------: |
| temporal    |     124 |
| worker      |     120 |
| postgres    |      96 |
| api         |      85 |
| s3          |      71 |
| web (nginx) |      14 |
| redis       |       8 |
| temporal-ui |       7 |
| **Total**   | **525** |

LLM-ops Lite adds no container: prompts, scores, the drift workflow and metrics live in the
existing worker, API and Postgres. Promptfoo runs only while `pnpm eval` runs (a short-lived
container, not counted).

## Full (`--profile llmops`, Langfuse 4.76.0)

| Container               |                    After warm-up, MiB | After 10k spans, MiB |              Limit (compose) |
| ----------------------- | ------------------------------------: | -------------------: | ---------------------------: |
| langfuse-web            |                                   679 |                  701 | 1536 MiB (Node heap 768 MiB) |
| clickhouse              |                                   658 |           669 to 690 |                     1536 MiB |
| langfuse-worker         |                                   455 |                  513 | 1024 MiB (Node heap 768 MiB) |
| postgres                | 111 (+15 for the `langfuse` database) |                      |                              |
| s3, worker, api, others |               as in Lite (+12 for s3) |                      |                              |
| **Total stack**         |                              **2352** |       about **2450** |                              |

Langfuse's own share is about 1.8 GiB after warm-up and about 1.9 GiB after a burst of 10,000
spans sent in 2.7 s (the client's span queue dropped part of them, so fewer arrived; the
Langfuse worker peaked at about 200 % CPU while ingesting). Measured with a 1 GiB limit on
langfuse-web, raised to 1.5 GiB afterwards for headroom. No container was OOM-killed.

## Verdict for a 24 GB / 8 CPU box

- **Lite fits easily**: about 0.5 GiB for the whole stack, leaving the box to the app's real
  load (Postgres cache, worker concurrency).
- **Full fits by memory**: about 2.5 GiB for the whole stack, about 4 GiB if every Langfuse
  container grows to its limit. It runs, and we saw no OOM.
- **But Full on that box is below Langfuse's own guidance**: Langfuse asks for at least 4 cores
  and 16 GiB for a Docker Compose VM, ClickHouse alone 2 CPU / 8 GiB, and calls a
  single-container ClickHouse "development only" (ADR 0009). Our limits work for low traffic
  (thousands of traces a day). Ingestion bursts compete for CPU with the app, and ClickHouse
  needs its own backups and disk. For production traffic put Langfuse on its own host or use
  managed Langfuse, and keep this server on Lite.
- Whether the small tier runs Langfuse at all is an open owner decision (ADR 0009).

## Reproduce

```sh
docker compose up -d --build --wait                          # Lite
PLAYWRIGHT_PORT=8080 PORT=3000 pnpm --filter web exec playwright test   # warm-up, x3
docker stats --no-stream
docker compose --profile llmops up -d --wait                 # Full (set the llmops vars from .env.example)
```

With a non-default `WEB_PORT`, set `BETTER_AUTH_URL` to the same origin before `up`.
