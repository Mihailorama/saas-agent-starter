#!/bin/sh
# Backup sidecar: prepares the repository, takes the first full backup and restore check on a
# fresh repository, then runs the schedule (supercronic: cron syntax, env and stdout logs).
. /backup/bin/lib.sh

# Wait for a writable primary (after an in-place restore it first replays WAL).
until [ "$(src_psql -d postgres -c "select pg_is_in_recovery()" 2>/dev/null)" = f ]; do sleep 2; done

# The bucket must exist. Creating it is best effort (real S3: create it yourself, see docs).
region=$PGBACKREST_REPO1_S3_REGION
code=$(curl -sS -o /dev/null -w '%{http_code}' ${PGBACKREST_REPO1_STORAGE_CA_FILE:+--cacert "$PGBACKREST_REPO1_STORAGE_CA_FILE"} \
  --aws-sigv4 "aws:amz:$region:s3" --user "$PGBACKREST_REPO1_S3_KEY:$PGBACKREST_REPO1_S3_KEY_SECRET" \
  -X PUT "https://$PGBACKREST_REPO1_S3_ENDPOINT:$PGBACKREST_REPO1_STORAGE_PORT/$PGBACKREST_REPO1_S3_BUCKET" || true)
log "create bucket $PGBACKREST_REPO1_S3_BUCKET: HTTP $code (409/403 are fine if it already exists)"

pgbackrest stanza-create
if [ "$(pgbackrest info --output=json | jq '.[0].backup | length')" = 0 ]; then
  log "empty repository: first full backup and restore check"
  /backup/bin/backup.sh full
  /backup/bin/restore-check.sh || log "first restore check failed (see above)"
fi
/backup/bin/status.sh
touch /tmp/ready

cat >/tmp/crontab <<CRON
$BACKUP_FULL_CRON /backup/bin/backup.sh full
$BACKUP_DIFF_CRON /backup/bin/backup.sh diff
*/5 * * * * /backup/bin/status.sh
$BACKUP_OBJECTS_CRON /backup/bin/objects.sh backup
$RESTORE_CHECK_CRON /backup/bin/restore-check.sh
CRON
exec supercronic -json /tmp/crontab
