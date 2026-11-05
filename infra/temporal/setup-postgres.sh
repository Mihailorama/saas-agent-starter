#!/bin/sh
# Creates Temporal's own databases on the shared Postgres server.
# Adapted from temporalio/samples-server compose/scripts/setup-postgres.sh (MIT).
set -eu
tool="temporal-sql-tool --plugin postgres12 --ep $POSTGRES_SEEDS -u $POSTGRES_USER -p 5432"
schema=/etc/temporal/schema/postgresql/v12
for db in temporal temporal_visibility; do
  dir=$([ "$db" = temporal ] && echo temporal || echo visibility)
  $tool --db "$db" create || true # already exists on re-runs
  $tool --db "$db" setup-schema -v 0.0 || true # no-op once versioned
  $tool --db "$db" update-schema -d "$schema/$dir/versioned"
done
