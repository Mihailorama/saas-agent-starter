#!/bin/sh
# Restore check: restores the latest backup plus all archived WAL into a throwaway Postgres in
# this container, then compares it with the live server: database list, migration versions and
# row counts of RESTORE_CHECK_TABLES (db.schema.table) within RESTORE_CHECK_TOLERANCE.
. /backup/bin/lib.sh
base=/var/lib/restore-check dir=/var/lib/restore-check/data port=55432
group=job/restore_check/stanza/$PGBACKREST_STANZA
start=$(now)
r_psql() { psql -X -h "$base" -p "$port" -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }
cleanup() { pg_ctl -D "$dir" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir"; }
fail() {
  log "ERROR: restore check failed: $*"
  [ -f "$base/log" ] && tail -n 20 "$base/log" >&2
  echo "restore_check_last_failure_timestamp_seconds $(now)" | push_metrics "$group" POST
  exit 1
}
trap cleanup EXIT

# Migration/schema version per database (only for databases that exist on the source).
versions='app|select hash from drizzle.__drizzle_migrations order by id desc limit 1
temporal|select curr_version from schema_version
temporal_visibility|select curr_version from schema_version'
dbs_sql="select datname from pg_database where not datistemplate order by 1"

# measure <psql function>: one "key value" line per check; "missing" when it cannot be read.
measure() {
  echo "$versions" | while IFS='|' read -r db sql; do
    echo "$src_dbs" | grep -qx "$db" || continue
    echo "version:$db $("$1" -d "$db" -c "$sql" 2>/dev/null || echo missing)"
  done
  for t in $RESTORE_CHECK_TABLES; do
    db=${t%%.*} rest=${t#*.}
    echo "$src_dbs" | grep -qx "$db" || continue
    echo "count:$t $("$1" -d "$db" -c "select count(*) from \"${rest%%.*}\".\"${rest#*.}\"" 2>/dev/null || echo missing)"
  done
}

for t in $RESTORE_CHECK_TABLES; do
  echo "$t" | grep -Eqx '[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*' \
    || fail "RESTORE_CHECK_TABLES entry '$t' is not db.schema.table"
done

# 1. Archiving works end to end; this also switches WAL, so the restore below contains every
#    transaction committed before this point.
pgbackrest check || fail "pgbackrest check"
src_dbs=$(src_psql -d postgres -c "$dbs_sql") || fail "cannot read the source server"
src=$(measure src_psql)

# 2. Restore into a scratch directory and start it on a private socket, no archiving. From here
#    on pg1-path is the scratch copy, so its restore_command can never write to the live server.
export PGBACKREST_PG1_PATH="$dir"
cleanup
install -d -m 700 "$dir"
pgbackrest restore --pg1-path="$dir" --archive-mode=off || fail "pgbackrest restore"
pg_ctl -D "$dir" -l "$base/log" -w -t 3600 \
  -o "-c port=$port -c listen_addresses= -c unix_socket_directories=$base -c shared_buffers=32MB" \
  start >/dev/null || fail "restored server did not start"
i=0
until [ "$(r_psql -d postgres -c 'select pg_is_in_recovery()' 2>/dev/null)" = f ]; do
  i=$((i + 1)) && [ "$i" -lt 3600 ] || fail "WAL replay did not finish"
  sleep 1
done

# 3. Compare.
[ "$(r_psql -d postgres -c "$dbs_sql")" = "$src_dbs" ] || fail "database list differs"
restored=$(measure r_psql)
echo "$src" | while read -r key s; do
  r=$(echo "$restored" | awk -v k="$key" '$1 == k { print $2 }')
  [ "$s" != missing ] || log "WARN: $key not found on the source server"
  [ "$r" = "$s" ] && continue
  case $key in
  count:*) awk -v s="$s" -v r="$r" -v tol="$RESTORE_CHECK_TOLERANCE" 'BEGIN {
      if (s !~ /^[0-9]+$/ || r !~ /^[0-9]+$/ || (s > 0 && r == 0)) exit 1
      d = r - s; if (d < 0) d = -d; exit !(d <= int(s * tol + 0.999999)) }' ;;
  *) false ;;
  esac || { log "$key: source $s, restored $r"; exit 1; }
done || fail "restored data differs from the source"

took=$(($(now) - start))
log "restore check passed in ${took}s: $(echo "$restored" | tr '\n' ' ')"
printf 'restore_check_last_success_timestamp_seconds %s\nrestore_check_duration_seconds %s\n' \
  "$(now)" "$took" | push_metrics "$group" POST
