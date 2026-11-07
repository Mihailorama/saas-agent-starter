#!/bin/sh
# backup.sh full|diff|incr: one pgBackRest backup of the whole server, then expire per retention.
. /backup/bin/lib.sh
type=${1:-full}
start=$(now)
if pgbackrest backup --type="$type"; then
  log "backup $type done in $(($(now) - start))s"
  /backup/bin/status.sh
else
  log "ERROR: backup $type failed"
  printf 'backup_last_failure_timestamp_seconds{type="%s"} %s\n' "$type" "$(now)" \
    | push_metrics job/pgbackrest_run/stanza/"$PGBACKREST_STANZA" POST
  exit 1
fi
