#!/bin/sh
# Shared helpers for the backup scripts. pgBackRest reads its PGBACKREST_* settings from the
# environment (compose.backup.yaml); rclone remotes are derived here.
set -eu

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# Source server: the live Postgres, over the socket shared with the postgres container.
src_psql() { psql -X -h /var/run/postgresql -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }

# push_metrics <group path> <method>: Prometheus text on stdin -> Pushgateway. PUT replaces the
# group, POST replaces only the metric names sent (keeps e.g. last_success next to last_failure).
push_metrics() {
  body=$(cat)
  [ -n "${BACKUP_PUSHGATEWAY_URL:-}" ] || return 0
  printf '%s\n' "$body" | curl -fsS -X "$2" --data-binary @- "$BACKUP_PUSHGATEWAY_URL/metrics/$1" \
    || log "WARN: could not push metrics to $BACKUP_PUSHGATEWAY_URL"
}

now() { date +%s; }

rclone_env() {
  ca=${PGBACKREST_REPO1_STORAGE_CA_FILE:-}
  export RCLONE_CONFIG_APP_TYPE=s3 RCLONE_CONFIG_APP_PROVIDER=Other \
    RCLONE_CONFIG_APP_ENDPOINT="$BACKUP_APP_S3_ENDPOINT" \
    RCLONE_CONFIG_APP_REGION="$BACKUP_APP_S3_REGION" \
    RCLONE_CONFIG_APP_ACCESS_KEY_ID="$BACKUP_APP_S3_ACCESS_KEY_ID" \
    RCLONE_CONFIG_APP_SECRET_ACCESS_KEY="$BACKUP_APP_S3_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_APP_FORCE_PATH_STYLE=true \
    RCLONE_CONFIG_REPO_TYPE=s3 RCLONE_CONFIG_REPO_PROVIDER=Other \
    RCLONE_CONFIG_REPO_ENDPOINT="https://$PGBACKREST_REPO1_S3_ENDPOINT:$PGBACKREST_REPO1_STORAGE_PORT" \
    RCLONE_CONFIG_REPO_REGION="$PGBACKREST_REPO1_S3_REGION" \
    RCLONE_CONFIG_REPO_ACCESS_KEY_ID="$PGBACKREST_REPO1_S3_KEY" \
    RCLONE_CONFIG_REPO_SECRET_ACCESS_KEY="$PGBACKREST_REPO1_S3_KEY_SECRET" \
    RCLONE_CONFIG_REPO_FORCE_PATH_STYLE="$([ "$PGBACKREST_REPO1_S3_URI_STYLE" = path ] && echo true || echo false)" \
    RCLONE_CONFIG_VAULT_TYPE=crypt \
    RCLONE_CONFIG_VAULT_REMOTE="repo:$PGBACKREST_REPO1_S3_BUCKET/objects"
  # Client-side encryption (NaCl secretbox) with the same passphrase as the pgBackRest repo.
  RCLONE_CONFIG_VAULT_PASSWORD=$(rclone obscure "$PGBACKREST_REPO1_CIPHER_PASS")
  RCLONE_CONFIG_VAULT_PASSWORD2=$(rclone obscure "salt:$PGBACKREST_REPO1_CIPHER_PASS")
  export RCLONE_CONFIG_VAULT_PASSWORD RCLONE_CONFIG_VAULT_PASSWORD2
  [ -z "$ca" ] || export RCLONE_CA_CERT="$ca"
}
