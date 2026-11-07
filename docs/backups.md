# Backups and restore

Design and trade-offs: [ADR 0015](adr/0015-backups.md). Everything here runs from the overlay
`compose.backup.yaml`; nothing is backed up without it.

## Turn it on

```sh
# .env (append :compose.permissive.yaml if you use the permissive twin)
COMPOSE_FILE=docker-compose.yml:compose.backup.yaml
docker compose up -d --wait
```

That gives you, locally, an encrypted pgBackRest repository in `backup-s3` (a second SeaweedFS
standing in for off-site storage), continuous WAL archiving, a first full backup and a first
restore check within a minute, then the schedule below. Watch it with
`docker compose logs -f backup`; metrics are on the Pushgateway (`:9091/metrics`) and, with the
`observability` profile, in Prometheus (`/alerts`, group `backups`) and Grafana.

**Production checklist** (in `.env` or the orchestrator):

1. Repository on another machine or provider than the server: `BACKUP_S3_ENDPOINT` (host
   only, e.g. `s3.eu-central-1.amazonaws.com`), `BACKUP_S3_HTTPS_PORT=443`,
   `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET` (create it first, private, ideally versioned),
   `BACKUP_S3_URI_STYLE` (`host` for AWS, `path` for most others),
   `BACKUP_S3_CA_FILE=/etc/ssl/certs/ca-certificates.crt`, and credentials
   `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` limited to that bucket. Then stop
   the local stand-in: `BACKUP_S3_LOCAL=0`. With `pnpm run deploy` (compose.prod.yaml) the env
   file carries all of this; see docs/deploy.md section 6.
2. `BACKUP_ENCRYPTION_PASSPHRASE`: long and random, set **before the first start** (it cannot be
   changed for an existing repository) and stored outside this server, e.g. in your password
   manager. Without it the backups cannot be decrypted.
3. App storage credentials for the object copy if they are not the local defaults:
   `BACKUP_APP_S3_ENDPOINT`, `BACKUP_APP_S3_REGION`, `BACKUP_APP_S3_ACCESS_KEY_ID`,
   `BACKUP_APP_S3_SECRET_ACCESS_KEY`, `BACKUP_APP_BUCKETS`.
4. Run the `observability` profile (or scrape the Pushgateway from your Prometheus) and route
   the alerts (Alertmanager, docs/TODO.md).
5. Do one restore drill (below) and write down how long it took.

## What is backed up

| Data                                                                                            | How                                               | Point in time            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------ |
| Postgres server, all databases: `app`, `temporal`, `temporal_visibility`                        | pgBackRest: WAL archive + weekly full, daily diff | any second in the window |
| `glitchtip` (`glitchtip`), `umami` (`analytics`), `langfuse` (`llmops`), `postiz` (`marketing`) | same: they live on the same Postgres server       | same                     |
| Any database a future profile creates on this server                                            | same, automatically                               | same                     |
| App buckets `attachments`, `ai-calls`, `langfuse` (`BACKUP_APP_BUCKETS`; missing = skipped)     | rclone, hourly encrypted copy + dated versions    | hourly                   |

**Not backed up:**

- **Redis / Valkey**: rate-limit counters only, they rebuild themselves. GlitchTip's queue in
  Redis db 1 is lost too (events in flight).
- **Prometheus, Loki, Jaeger** (observability profile): telemetry, not customer data.
- **Unlogged tables** on any database: Postgres does not write them to WAL, restores have them
  empty (the e2e test relies on this to prove the restore check fails on a difference).
- **ClickHouse** (`llmops` profile): Langfuse's traces and scores in the `clickhousedata`
  volume. Langfuse's Postgres database and its `langfuse` bucket are covered (above); losing
  ClickHouse loses trace history, not prompts or configuration. Back it up with ClickHouse's own
  `BACKUP ... TO S3` if that history matters.
- **Chatwoot** (`support` profile): **not covered.** It runs its own Postgres
  (`chatwoot-postgres`, pgvector image, volume `chatwoot-pgdata`), not this server, plus
  attachments in the `chatwoot-storage` volume and its queue in Redis db 2. Conversations with
  customers live there: until it has its own backup (docs/TODO.md), take `pg_dump` of
  `chatwoot-postgres` and a copy of `chatwoot-storage` on your own schedule.
- **Marketing profile files**: Postiz uploads (`postiz-uploads` volume, `STORAGE_PROVIDER=local`)
  and SerpBear's SQLite data (`serpbear-data` volume). Postiz's database is covered (above).
  Copy those two volumes yourself if they matter, or point Postiz storage at a bucket listed in
  `BACKUP_APP_BUCKETS`.
- Container images, `.env` and secrets: rebuild from git; secrets belong in your password manager.
- The backup bucket itself: protect it with the provider's versioning / object lock and keep it
  in another account or region if you need to survive a compromised server.

## RPO and RTO

Measured with this repository's scripts (e2e numbers in the CI log of the `backup` job):

- **RPO (Postgres): at most `BACKUP_ARCHIVE_TIMEOUT` (60 s) of commits.** A busy server ships
  each 16 MB WAL segment as soon as it is full; a quiet one ships a partial segment every 60 s.
  Measured in the e2e runs: a commit on a quiet server reached the repository after 53-56 s.
- **RPO (objects): up to 1 hour** (`BACKUP_OBJECTS_CRON`, hourly).
- **RTO (Postgres)**, measured locally (repository on the same host, docs/STACK.md): a 784 MB
  database restored to a new instance in 24 s (the pgBackRest restore itself 14 s, about
  55 MB/s); the e2e in-place disaster restore of a small database, including stopping and
  starting the services, took 23 s on a GitHub runner and 33-56 s on a busy shared host. Off-site, restore time grows with database size over the
  download bandwidth: about 14 minutes for 10 GB at 100 Mbit/s, plus WAL replay since the last
  backup (at most a day of changes with daily backups). Measure your own with a drill.
- **RTO (objects)**: one `rclone copy` of every bucket, bounded by size and bandwidth.
- Backup window and retention: `BACKUP_RETENTION_FULL=4` weekly full backups, so point-in-time
  recovery reaches back three to four weeks; object versions `BACKUP_OBJECTS_RETENTION_DAYS=30`.

## Schedule and settings

| Variable                        | Default                                             | Meaning                                     |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| `BACKUP_FULL_CRON`              | `0 2 * * 0`                                         | full backup (Sunday 02:00, container time)  |
| `BACKUP_DIFF_CRON`              | `0 2 * * 1-6`                                       | differential backup, other days             |
| `BACKUP_OBJECTS_CRON`           | `15 * * * *`                                        | app bucket copy                             |
| `RESTORE_CHECK_CRON`            | `0 4 * * 0`                                         | restore check                               |
| `BACKUP_RETENTION_FULL`         | `4`                                                 | full backups kept (and the WAL they need)   |
| `BACKUP_OBJECTS_RETENTION_DAYS` | `30`                                                | overwritten/deleted object versions kept    |
| `BACKUP_ARCHIVE_TIMEOUT`        | `60`                                                | max seconds before a WAL segment is shipped |
| `BACKUP_PROCESS_MAX`            | `4`                                                 | parallel file transfers in backup/restore   |
| `RESTORE_CHECK_TABLES`          | `app.public.{organization,user,projects,audit_log}` | row counts compared                         |
| `RESTORE_CHECK_TOLERANCE`       | `0.05`                                              | allowed relative difference per table       |

Alert thresholds in `infra/otel/alerts.yml` assume these schedules; change both together.

## Commands

```sh
pnpm run backup:now                       # full backup now (-- --type diff|incr for smaller ones)
pnpm run restore                          # latest state -> NEW instance on :5433 (RESTORE_POSTGRES_PORT)
pnpm run restore -- --target-time 2026-11-07T09:59:00Z   # point in time -> new instance
pnpm run restore -- --in-place --yes-overwrite-live [--target-time ...]   # replace the live database
docker compose exec backup /backup/bin/restore-check.sh   # restore check now
docker compose exec backup /backup/bin/objects.sh backup  # object copy now
docker compose exec backup /backup/bin/objects.sh restore # copy objects back into the app buckets
docker compose exec backup pgbackrest info                # backups, WAL range, sizes
```

The new instance (`postgres-restore`, `restore` profile) has its own volume, never archives and
leaves the live server alone: query it, `pg_dump` what you need from it, then remove it with
`docker compose --profile restore rm -sf postgres-restore`. A new restore replaces the previous
copy.

## Restore step by step

**Someone deleted or broke data (the server is fine).** Recover the rows from a copy:

1. Find the time just before the mistake (audit log, API logs in Loki, Temporal history). Times
   are ISO 8601 with a zone, e.g. `2026-11-07T09:59:00Z`.
2. `pnpm run restore -- --target-time <time>`; it prints the connection string of the copy.
3. Check the copy (`psql postgres://postgres:postgres@localhost:5433/app`), then move the rows
   back, e.g. `pg_dump --data-only -t <table>` from the copy into a staging table on the live
   database and merge them. Do not point the app at the copy.
4. `docker compose --profile restore rm -sf postgres-restore`.

**The whole database must go back in time** (bad migration, corrupted data everywhere):

1. Restore a copy at the target time first (as above) and confirm it is the state you want.
2. `pnpm run restore -- --in-place --yes-overwrite-live --target-time <time>`. It stops every
   running service except the backup storage, restores into the live data directory, starts
   Postgres on a new timeline, waits for recovery and starts the services again.
   **Everything written after the target time is gone** (it stays in the repository until
   retention removes it, so a second restore to a later time is still possible).
3. `pnpm run backup:now`, then `docker compose exec backup /backup/bin/restore-check.sh`.

**The server or its disk is gone** (the repository is off-site):

1. New server, same repository checkout, same `.env` (including `BACKUP_ENCRYPTION_PASSPHRASE`
   and the `BACKUP_S3_*` settings). For the local `backup-s3` stand-in this only works while its
   volume survives; that is why production uses off-site storage.
2. `docker compose up -d --wait s3` (empty app storage), then
   `pnpm run restore -- --in-place --yes-overwrite-live` (latest state; the data volume is
   created empty and filled from the repository).
3. `docker compose exec backup /backup/bin/objects.sh restore` (app buckets).
4. `docker compose up -d --wait`, sign in, check recent data. Then `pnpm run backup:now`.

This exact sequence (minus the new server) runs in CI on every push: `scripts/backup-e2e.sh`.
Run it locally with `./scripts/backup-e2e.sh` (own compose project and ports 2753x/2759x, torn
down at the end, `KEEP=1` to keep it).

## When an alert fires

- `BackupMetricsMissing`: the overlay is not running, or the Pushgateway lost its volume. Check
  `docker compose ps backup pushgateway`; `docker compose restart backup` re-pushes the backup
  state, `restore-check.sh` the restore check.
- `BackupTooOld`, `BackupFailed`: `docker compose logs backup`. Usual causes: repository
  unreachable or credentials, disk full, a long-running full backup.
- `WalArchiveFailing`: `docker compose logs postgres | grep archive`. Fix the repository access
  quickly: until then `pg_wal` grows and point-in-time recovery stops at the last archived
  segment. `docker compose exec backup pgbackrest check` confirms the fix.
- `BackupStatusStale`: the sidecar died; `docker compose up -d backup`.
- `RestoreCheckFailed`: the log line names the failing check (`docker compose logs backup`).
  A row-count difference beyond tolerance right after heavy writes can be a false positive;
  rerun the check. A failed restore or a missing database is real: fix it before anything else.
- `RestoreCheckTooOld`: the weekly check has not succeeded in 35 days; run it by hand.
