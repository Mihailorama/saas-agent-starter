#!/bin/sh
# One-shot of compose.prod.yaml (vault-db, umami-db): role $DB_NAME with $DB_PASSWORD and a
# database of the same name owned by it, on the server libpq's PG* variables point at.
# Idempotent; the password is set again on every run (rotation). Values reach psql through the
# environment (\getenv), never argv. No DB_PASSWORD: created by hand (docs/deploy.md), skipped.
set -eu
[ -n "${DB_PASSWORD:-}" ] || { echo "$DB_NAME: DB_PASSWORD not set, skipped"; exit 0; }
psql -q -v ON_ERROR_STOP=1 <<'SQL'
\getenv name DB_NAME
\getenv pw DB_PASSWORD
select format('create role %I login', :'name')
  where not exists (select 1 from pg_roles where rolname = :'name') \gexec
select format('alter role %I password %L', :'name', :'pw') \gexec
select format('create database %I owner %I', :'name', :'name')
  where not exists (select 1 from pg_database where datname = :'name') \gexec
SQL
echo "$DB_NAME: role and database ready"
