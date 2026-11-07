# The stack's Postgres image (ADR 0015, docs/backups.md). Two targets on one base, so the data
# directory works with both: `postgres` (docker-compose.yml) and `backup` (compose.backup.yaml).
#
# postgres: postgres:17-alpine + the pgvector extension (Chatwoot's schema enables `vector`,
# docs/support.md). Alpine's own pgvector package is built for its PostgreSQL 18, so it is
# compiled here against the image's PostgreSQL 17 (pinned tarball, checksum verified). Only the
# extension files are added; no database uses it unless it runs `create extension vector`.
FROM postgres:17-alpine AS postgres
ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85
RUN apk add --no-cache --virtual .build build-base curl \
  && cd /tmp \
  && curl -fsSLo pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v$PGVECTOR_VERSION.tar.gz" \
  && echo "$PGVECTOR_SHA256  pgvector.tar.gz" | sha256sum -c - \
  && tar xzf pgvector.tar.gz && cd "pgvector-$PGVECTOR_VERSION" \
  # OPTFLAGS="": portable binary (no -march=native); with_llvm=no: no JIT bitcode (needs clang)
  && make OPTFLAGS="" with_llvm=no && make install with_llvm=no \
  && cd / && rm -rf /tmp/pgvector* && apk del .build

# backup: + pgBackRest, rclone, supercronic. Alpine's pgbackrest package depends on its own
# `postgresql18` package; those binaries land in /usr/bin and are unused (PATH and our scripts
# use the image's PostgreSQL 17 in /usr/local/bin).
FROM postgres AS backup
RUN apk add --no-cache pgbackrest rclone supercronic curl jq openssl \
  && install -d -o postgres -g postgres /var/lib/restore-check
# --chmod: the deploy ships these files without their executable bit (scripts/deploy.mjs)
COPY --chmod=755 bin/ /backup/bin/
