#!/bin/sh
# Pushes backup state read from its sources of truth: the pgBackRest repository (last backup of
# each type) and pg_stat_archiver (WAL archiving). Runs every 5 minutes and after each backup.
. /backup/bin/lib.sh
info=$(pgbackrest info --output=json)
archiver=$(src_psql -d postgres -c "select coalesce(extract(epoch from last_archived_time), 0)::bigint,
  (coalesce(last_failed_time > last_archived_time, last_failed_time is not null))::int from pg_stat_archiver")
{
  echo '# TYPE backup_last_success_timestamp_seconds gauge'
  printf '%s' "$info" | jq -r '.[0].backup | group_by(.type)[] | max_by(.timestamp.stop)
    | "backup_last_success_timestamp_seconds{type=\"\(.type)\"} \(.timestamp.stop)"'
  echo "pg_wal_archive_last_success_timestamp_seconds ${archiver%|*}"
  echo "pg_wal_archive_failing ${archiver#*|}"
} | push_metrics job/pgbackrest/stanza/"$PGBACKREST_STANZA" PUT
