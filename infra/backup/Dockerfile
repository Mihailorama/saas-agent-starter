# Postgres + backup tools (ADR 0015, docs/backups.md). Same base image as the `postgres` service
# in docker-compose.yml: keep the tags equal, the data directory is shared between them.
# Alpine's pgbackrest package depends on its own `postgresql18` package; those binaries land in
# /usr/bin and are unused (PATH and our scripts use the image's PostgreSQL 17 in /usr/local/bin).
FROM postgres:17-alpine
RUN apk add --no-cache pgbackrest rclone supercronic curl jq openssl \
  && install -d -o postgres -g postgres /var/lib/restore-check
COPY bin/ /backup/bin/
