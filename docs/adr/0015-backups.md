# 0015. Backups with verified restore

Status: accepted

## Context

There were no backups: losing the disk lost every customer's data. The app, Temporal, GlitchTip, Umami,
Langfuse, Postiz and Chatwoot databases live on one Postgres server; uploaded files (including
Chatwoot attachments) and AI call content live in S3 buckets. A backup that has never been restored is a hope,
so restores must be tested automatically and their absence must page someone.

## Decision

- **pgBackRest** (MIT) for Postgres: continuous WAL archiving plus scheduled full (weekly) and
  differential (daily) backups, point-in-time recovery, retention (`BACKUP_RETENTION_FULL`
  full backups and the WAL they need), zstd compression, AES-256 client-side encryption, S3
  repository. It backs up the whole server, so every database on it is covered, including
  ones a future profile adds. Preferred over WAL-G for its built-in repository checks
  (`pgbackrest check`), delta restore and backup selection by target time. It runs cleanly here: `archive_command` must run inside the Postgres container,
  so `compose.backup.yaml` builds the stack's Postgres image (`postgres:17-alpine` with
  pgvector) with Alpine's `pgbackrest` package added (`infra/backup/Dockerfile`, target `backup`), and a sidecar using the same image takes the backups from
  the shared data volume and socket. One constraint: pgBackRest talks to S3 over TLS only, so
  the local stand-in for off-site storage (`backup-s3`, a second SeaweedFS) serves HTTPS with
  a self-signed certificate that the clients pin as their CA. TLS is always verified.
- **Separate repository storage.** The repository goes to its own bucket and endpoint
  (`BACKUP_S3_*`), never the app's storage, so it can be another provider or region.
- **App objects: a scheduled encrypted copy, not bucket versioning.** rclone (MIT) syncs every
  app bucket hourly to the backup bucket through a `crypt` remote (client-side encryption, same
  passphrase), and moves objects that a sync would overwrite or delete into dated version
  folders that are kept `BACKUP_OBJECTS_RETENTION_DAYS`. Versioning plus a lifecycle rule
  stays on the same storage as the data, so it does not survive the disk failure this is
  about, and not every S3-compatible server implements it. Enable versioning on top where the
  provider has it.
- **Restore check in a compose cron container, not a Temporal Schedule.** The check needs the
  pgBackRest binary, the repository and a Postgres server binary to start a throwaway copy,
  which the Python worker does not have. Temporal's own database is one of the things being
  restored, so it must not depend on Temporal running. The sidecar runs supercronic (MIT;
  cron syntax, keeps the container environment, logs to stdout). The check runs
  `pgbackrest check` (archiving works end to end; forces a WAL switch), restores the latest
  backup plus all WAL into a scratch directory, starts it on a private socket without
  archiving, waits for recovery to finish and compares it with the live server: same database
  list, same migration version (`drizzle.__drizzle_migrations` in `app`, `schema_version` in
  the Temporal databases) and row counts of `RESTORE_CHECK_TABLES` within
  `RESTORE_CHECK_TOLERANCE`, never zero when the source is not. It runs weekly, and once on a
  fresh repository right after the first full backup.
- **Status from metrics, no backup history table.** Backup times come from the repository
  itself (`pgbackrest info`), WAL archiving from `pg_stat_archiver`, run outcomes from the
  scripts. Prometheus Pushgateway (Apache-2.0, the Prometheus project's component for batch
  job results) holds them, persisted to a volume. Alerts in `infra/otel/alerts.yml`, with
  promtool unit tests: backup older than 26 h, backup failed, WAL archiving failing, sidecar
  silent for 30 min, object copy older than 6 h, restore check failed, restore check older
  than 35 days, and no metrics at all (backups not running).
- **Commands.** `pnpm run backup:now` and `pnpm run restore` (`scripts/backup.mjs`). A
  restore goes to a new instance (`postgres-restore`, its own volume and port, archiving off)
  unless both `--in-place` and `--yes-overwrite-live` are given.
- **Opt-in overlay file**, like the permissive twin: `COMPOSE_FILE=docker-compose.yml:compose.backup.yaml`.
  The base `docker-compose.yml` is unchanged, so local development without backups stays as
  light as before. CI runs `scripts/backup-e2e.sh`: write data, back up, point-in-time restore
  to a new instance, delete the database and object storage volumes, restore in place, assert
  the data, a restore check that must fail, and the alert firing in Prometheus.

## Consequences

- RPO: up to `archive_timeout` (60 s) of commits when the server dies; RTO: minutes for a
  small database, then bounded by download speed (docs/backups.md has the measured numbers).
- The encryption passphrase is the single point of failure: it cannot be changed for an
  existing repository and without it nothing can be restored. It must be stored off the server.
- WAL archiving that keeps failing fills `pg_wal` until the disk is full; `WalArchiveFailing`
  pages after 10 minutes.
- The restore check needs free disk space for one more copy of the database in the
  `restorecheck` volume, and CPU/IO while it replays WAL.
- Not covered: ClickHouse (Langfuse traces), Redis (rate-limit counters, queues), Prometheus/Loki/Jaeger telemetry and
  unlogged tables. docs/backups.md lists them.
