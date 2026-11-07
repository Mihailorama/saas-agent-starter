#!/usr/bin/env bash
# Backup -> destroy -> restore, end to end (CI job `backup`; runs locally the same way).
# Real containers from compose.backup.yaml under their own compose project, torn down at the end
# (KEEP=1 keeps them). Host ports are configurable; the script aborts if one is already taken.
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-backup-e2e}
export COMPOSE_FILE=docker-compose.yml:compose.backup.yaml
export POSTGRES_PORT=${POSTGRES_PORT:-27532} S3_PORT=${S3_PORT:-27533}
export RESTORE_POSTGRES_PORT=${RESTORE_POSTGRES_PORT:-27535}
export PUSHGATEWAY_PORT=${PUSHGATEWAY_PORT:-27591} PROMETHEUS_PORT=${PROMETHEUS_PORT:-27590}
export DATABASE_URL=postgres://app_user:app_user_password@127.0.0.1:$POSTGRES_PORT/app
export MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:$POSTGRES_PORT/app
PROM_IMAGE=prom/prometheus:v3.15.1

for port in $POSTGRES_PORT $S3_PORT $RESTORE_POSTGRES_PORT $PUSHGATEWAY_PORT $PROMETHEUS_PORT; do
  if ss -ltnH "sport = :$port" | grep -q .; then echo "port $port is in use, aborting" >&2 && exit 1; fi
done

dc() { docker compose --profile restore "$@"; }
step() { echo "=== $(date -u +%T) $*"; }
fail() { echo "FAIL: $*" >&2 && exit 1; }
live() { dc exec -T postgres psql -X -q -U postgres -d "${2:-app}" -v ON_ERROR_STOP=1 -tAc "$1"; }
copy() { dc exec -T postgres-restore psql -X -q -U postgres -d app -v ON_ERROR_STOP=1 -tAc "$1"; }
expect() { [ "$2" = "$3" ] || fail "$1: expected '$3', got '$2'"; }
in_backup() { dc exec -T backup "$@"; }
prom() { curl -fsS "http://127.0.0.1:$PROMETHEUS_PORT/api/v1/query" --data-urlencode "query=$1"; }
until_ok() { # until_ok <seconds> <command...>
  local end=$((SECONDS + $1)) && shift
  until "$@" >/dev/null 2>&1; do [ $SECONDS -lt $end ] || return 1; sleep 2; done
}
cleanup() {
  local rc=$?
  [ $rc = 0 ] || dc logs --tail 60 postgres backup backup-s3 postgres-restore || true
  [ -n "${KEEP:-}" ] || docker compose --profile '*' down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit $rc
}
trap cleanup EXIT

step "alert rules: syntax and unit tests"
docker run --rm --entrypoint promtool -v "$PWD/infra/otel:/r:ro" "$PROM_IMAGE" check rules /r/alerts.yml
docker run --rm --entrypoint promtool -v "$PWD/infra/otel:/r:ro" -w /r "$PROM_IMAGE" test rules alerts.test.yml

step "start postgres (WAL archiving), app S3, backup S3, pushgateway, prometheus"
dc build postgres
dc up -d --wait postgres s3 backup-s3 pushgateway prometheus
dc run --rm temporal-setup >/dev/null # Temporal's databases live on the same server
pnpm db:migrate
live "insert into organization (id, name, slug, created_at) values ('org-e2e', 'E2E', 'e2e', now())"
live "insert into projects (org_id, name) select 'org-e2e', 'p' || g from generate_series(1, 1000) g"
migration=$(live "select hash from drizzle.__drizzle_migrations order by id desc limit 1")
temporal_version=$(live "select curr_version from schema_version" temporal)

step "backup sidecar: stanza, first full backup, first restore check"
dc up -d --wait backup
in_backup sh -c '. /backup/bin/lib.sh && rclone_env && echo "hello from e2e" | rclone rcat app:attachments/e2e/hello.txt'
in_backup /backup/bin/objects.sh backup

step "more writes, differential backup (pnpm run backup:now -- --type diff)"
live "insert into projects (org_id, name) select 'org-e2e', 'q' || g from generate_series(1, 500) g"
pnpm run --silent backup:now -- --type diff
live "insert into projects (org_id, name) values ('org-e2e', 'before-target')"
sleep 2 && target=$(date -u +%FT%T.%3NZ) && sleep 2
committed=$(live "insert into projects (org_id, name) values ('org-e2e', 'after-target') returning extract(epoch from now())")
archived() { [ "$(live "select coalesce(extract(epoch from last_archived_time) >= $committed, false) from pg_stat_archiver")" = t ]; }
until_ok 120 archived || fail "WAL with the last commit was not archived within 120s"
echo "RPO sample: last commit archived after $(live "select round(extract(epoch from last_archived_time) - $committed) from pg_stat_archiver")s (archive_timeout ${BACKUP_ARCHIVE_TIMEOUT:-60}s)"
in_backup pgbackrest check >/dev/null # every commit above is in the repository now

step "point-in-time restore to a NEW instance at $target (default target)"
pnpm run --silent restore -- --target-time "$target"
expect "projects in the copy" "$(copy 'select count(*) from projects')" 1501
expect "row after target in the copy" "$(copy "select count(*) from projects where name = 'after-target'")" 0
expect "live database untouched" "$(live "select count(*) from projects where name = 'after-target'")" 1

step "disaster: delete the database server and the app object storage (volumes)"
dc stop
dc rm -f postgres s3 backup postgres-restore >/dev/null
docker volume rm "${COMPOSE_PROJECT_NAME}_pgdata" "${COMPOSE_PROJECT_NAME}_s3data" "${COMPOSE_PROJECT_NAME}_pgrun" >/dev/null
dc up -d --wait backup-s3 pushgateway prometheus s3 # off-site repo + a fresh, empty app storage

step "restore in place (latest), then the app objects"
start=$SECONDS
pnpm run --silent restore -- --in-place --yes-overwrite-live
echo "RTO sample: in-place restore of the server took $((SECONDS - start))s"
expect "projects after restore" "$(live 'select count(*) from projects')" 1502
expect "last commit present" "$(live "select count(*) from projects where name = 'after-target'")" 1
expect "app migration version" "$(live "select hash from drizzle.__drizzle_migrations order by id desc limit 1")" "$migration"
expect "temporal schema version" "$(live "select curr_version from schema_version" temporal)" "$temporal_version"
in_backup /backup/bin/objects.sh restore
expect "restored object" "$(in_backup sh -c '. /backup/bin/lib.sh && rclone_env && rclone cat app:attachments/e2e/hello.txt')" "hello from e2e"

step "restore check catches a difference (unlogged tables are not in backups)"
live "create unlogged table e2e_unlogged as select generate_series(1, 100) as n"
if dc exec -T -e RESTORE_CHECK_TABLES=app.public.e2e_unlogged backup /backup/bin/restore-check.sh; then
  fail "restore check passed although the restored table is empty"
fi
live "drop table e2e_unlogged"
firing() { prom 'ALERTS{alertname="RestoreCheckFailed",alertstate="firing"}' | grep -q RestoreCheckFailed; }
until_ok 120 firing || fail "RestoreCheckFailed did not fire in Prometheus"
echo "RestoreCheckFailed fired in Prometheus"

step "restore check passes after the restore; metrics reach Prometheus"
in_backup /backup/bin/restore-check.sh
in_backup /backup/bin/status.sh
metrics=$(curl -fsS "http://127.0.0.1:$PUSHGATEWAY_PORT/metrics")
for m in 'backup_last_success_timestamp_seconds{.*type="full"' 'backup_last_success_timestamp_seconds{.*type="diff"' \
  'pg_wal_archive_failing{.*} 0' restore_check_last_success_timestamp_seconds \
  object_backup_last_success_timestamp_seconds; do
  grep -Eq "^$m" <<<"$metrics" || fail "pushgateway has no $m"
done
seen() { prom 'time() - max(restore_check_last_success_timestamp_seconds) < 120' | grep -q '"value"'; }
until_ok 120 seen || fail "Prometheus does not see the latest restore check"
prom 'time() - max(backup_last_success_timestamp_seconds)' | jq -r '"Prometheus: last backup \(.data.result[0].value[1] | tonumber | floor)s ago"'

step "memory of the backup containers"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $(dc ps -q backup backup-s3 pushgateway postgres)
step "OK: backup -> destroy -> restore verified"
