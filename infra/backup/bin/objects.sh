#!/bin/sh
# objects.sh backup|restore: app buckets <-> an encrypted copy in the backup bucket (rclone).
# backup:  sync each bucket to vault:<bucket>/current. Objects the sync would overwrite or delete
#          move to vault:<bucket>/versions/<run time>, kept BACKUP_OBJECTS_RETENTION_DAYS days.
# restore: copy vault:<bucket>/current into the app bucket (adds/overwrites, never deletes).
. /backup/bin/lib.sh
rclone_env
cmd=${1:?usage: objects.sh backup|restore}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cutoff=$(date -u -d "@$(($(now) - BACKUP_OBJECTS_RETENTION_DAYS * 86400))" +%Y%m%d%H%M%S)
rc=0
for b in $BACKUP_APP_BUCKETS; do
  group=job/objects/bucket/$b
  if [ "$cmd" = restore ]; then
    rclone copy "vault:$b/current" "app:$b" && log "restored objects of bucket $b" \
      || { log "ERROR: restoring bucket $b failed"; rc=1; }
    continue
  fi
  if ! rclone lsf "app:$b" --max-depth 1 >/dev/null 2>&1; then
    log "bucket $b does not exist: nothing to back up"
  elif rclone sync "app:$b" "vault:$b/current" --backup-dir "vault:$b/versions/$stamp"; then
    for d in $(rclone lsf --dirs-only "vault:$b/versions" 2>/dev/null); do
      [ "$(echo "$d" | tr -dc 0-9)" -ge "$cutoff" ] || rclone purge "vault:$b/versions/${d%/}"
    done
    log "objects of bucket $b backed up"
  else
    log "ERROR: object backup of bucket $b failed"
    echo "object_backup_last_failure_timestamp_seconds $(now)" | push_metrics "$group" POST
    rc=1
    continue
  fi
  echo "object_backup_last_success_timestamp_seconds $(now)" | push_metrics "$group" POST
done
exit $rc
