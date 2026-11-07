#!/usr/bin/env bash
# Production rehearsal on this machine (docs/deploy.md "Rehearsal"): the real deploy path with a
# throwaway age key, Caddy's internal CA on 127.0.0.1:28080/28443 and DEPLOY_HOST=local.
#   v1 deploy -> v2 upgrade (adds an expand migration) -> rollback to v1 (runs on the expanded
#   schema) -> v3 with a failing migration (stopped before anything restarts, v1 keeps serving).
# Tears everything down at the end; KEEP=1 leaves the stack running for inspection.
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in sops age-keygen docker curl jq ss; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done
# Local images have digests only with the containerd image store (default in Docker 29).
[[ $(docker info 2>/dev/null) == *io.containerd.snapshotter* ]] ||
  { echo "needs Docker's containerd image store (features.containerd-snapshotter)" >&2; exit 1; }
HTTP_PORT=${HTTP_PORT:-28080}
HTTPS_PORT=${HTTPS_PORT:-28443}
PROJECT=${PROJECT:-saas-deploy-rehearsal}
REPO=localhost/$PROJECT
for p in "$HTTP_PORT" "$HTTPS_PORT"; do
  if [ -n "$(ss -ltnH "sport = :$p")" ]; then echo "port $p is in use: abort" >&2; exit 1; fi
done

work=$(mktemp -d)
server=$work/server
cleanup() {
  [ "${KEEP:-}" = 1 ] && { echo "kept: $server (docker compose down -v there)"; return; }
  if [ -f "$server/.env" ]; then (cd "$server" && docker compose down -v --remove-orphans -t 5) || true; fi
  for v in v1 v2 v3; do docker image rm -f "$REPO"/{api,worker,web}:$v >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '\n=== %s\n' "$*"; }
in_server() { (cd "$server" && "$@"); }
sql() { in_server docker compose exec -T postgres psql -U postgres -d app -tAc "$1"; }
digest_of() {
  docker image inspect --format '{{json .RepoDigests}}' "$REPO/$1" |
    jq -r --arg r "$REPO/${1%%:*}@" '.[] | select(startswith($r))'
}
expect_api() {
  local got want
  got=$(in_server docker compose ps --format '{{.Image}}' api)
  want=$(digest_of "api:$1")
  [ "$got" = "$want" ] || { echo "FAIL: api runs $got, expected $1 ($want)" >&2; exit 1; }
  echo "OK: api runs $1 ($want)"
}
expect_eq() { [ "$1" = "$2" ] || { echo "FAIL: $3: got '$1', want '$2'" >&2; exit 1; }; echo "OK: $3 = $2"; }
probe() {
  curl -fsS --cacert "$server/.caddy-root.crt" --resolve "app.localhost:$HTTPS_PORT:127.0.0.1" \
    "https://app.localhost:$HTTPS_PORT/api/auth/ok"
  echo
}

step "secrets: throwaway age key, example.env with random values, encrypted with sops"
age-keygen -o "$work/age.key" 2>/dev/null
export SOPS_AGE_KEY_FILE=$work/age.key
plain=$work/rehearsal.env
cp deploy/env/example.env "$plain"
kv() { if grep -q "^$1=" "$plain"; then sed -i "s|^$1=.*|$1=$2|" "$plain"; else echo "$1=$2" >>"$plain"; fi; }
rnd() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
pg=$(rnd)
kv DEPLOY_HOST local
kv DEPLOY_PATH "$server"
kv IMAGE_REPO "$REPO"
kv COMPOSE_PROJECT_NAME "$PROJECT"
kv COMPOSE_PROFILES db,s3
kv APP_DOMAIN app.localhost
kv CADDY_TLS internal
kv PUBLISH_IP 127.0.0.1
kv HTTP_PORT "$HTTP_PORT"
kv HTTPS_PORT "$HTTPS_PORT"
kv BETTER_AUTH_URL "https://app.localhost:$HTTPS_PORT"
kv POSTGRES_PASSWORD "$pg"
kv TEMPORAL_DB_PASSWORD "$pg"
kv MIGRATION_DATABASE_URL "postgres://postgres:$pg@postgres:5432/app"
kv DATABASE_URL "postgres://app_user:$(rnd)@postgres:5432/app"
kv BETTER_AUTH_SECRET "$(rnd)$(rnd)"
kv S3_ENDPOINT http://s3:8333
kv S3_ACCESS_KEY_ID "$(rnd)"
kv S3_SECRET_ACCESS_KEY "$(rnd)"
# --config /dev/null: the repo .sops.yaml rules are for deploy/env/, not this temp file
sops --config /dev/null encrypt --age "$(age-keygen -y "$SOPS_AGE_KEY_FILE")" --input-type dotenv \
  --output-type dotenv "$plain" >"$work/rehearsal.enc.env"
rm -f "$plain"
export DEPLOY_ENV_FILE=$work/rehearsal.enc.env
grep -c 'ENC\[' "$DEPLOY_ENV_FILE" | sed 's/^/encrypted values: /'

step "images: v1 from this checkout; v2 adds an expand migration; v3 a failing one"
docker build -q -f apps/api/Dockerfile --build-arg GIT_SHA=v1 -t "$REPO/api:v1" . >/dev/null
docker build -q -f services/worker-py/Dockerfile --build-arg GIT_SHA=v1 -t "$REPO/worker:v1" . >/dev/null
docker build -q -f apps/web/Dockerfile --build-arg VITE_RELEASE=v1 -t "$REPO/web:v1" . >/dev/null
ctx=$work/ctx
mkdir -p "$ctx"
journal=packages/db/migrations/meta/_journal.json
add_migration() { # <from image> <to tag> <tag of migration> <sql>
  local now
  now=$(date +%s%3N)
  printf '%s\n' "$4" >"$ctx/$3.sql"
  docker run --rm --entrypoint cat "$1" "/app/$journal" |
    jq --arg t "$3" --argjson w "$now" \
      '.entries += [{idx: (.entries | length), version: "7", when: $w, tag: $t, breakpoints: true}]' \
      >"$ctx/_journal.json"
  printf 'FROM %s\nCOPY %s.sql /app/packages/db/migrations/\nCOPY _journal.json /app/%s\n' \
    "$1" "$3" "$journal" >"$ctx/Dockerfile"
  docker build -q -t "$2" "$ctx" >/dev/null
}
add_migration "$REPO/api:v1" "$REPO/api:v2" 0002_rehearsal_expand \
  'ALTER TABLE "projects" ADD COLUMN "rehearsal_note" text;'
add_migration "$REPO/api:v2" "$REPO/api:v3" 0003_rehearsal_broken \
  'ALTER TABLE "projects" ADD COLUMN "broken" no_such_type;'
for v in v2 v3; do
  for n in worker web; do
    printf 'FROM %s\nLABEL rehearsal=%s\n' "$REPO/$n:v1" "$v" | docker build -q -t "$REPO/$n:$v" - >/dev/null
  done
done
for v in v1 v2 v3; do echo "$v api $(digest_of "api:$v")"; done

step "deploy v1"
node scripts/deploy.mjs rehearsal --version v1
expect_api v1
expect_eq "$(sql 'select count(*) from drizzle.__drizzle_migrations')" 2 "applied migrations"

step "upgrade to v2 (migrate runs before api/worker start)"
node scripts/deploy.mjs rehearsal --version v2
expect_api v2
expect_eq "$(sql 'select count(*) from drizzle.__drizzle_migrations')" 3 "applied migrations"
expect_eq "$(sql "select count(*) from information_schema.columns where column_name = 'rehearsal_note'")" 1 \
  "expand column present"

step "rollback to v1 (old code on the expanded schema)"
node scripts/deploy.mjs rehearsal --rollback
expect_api v1
expect_eq "$(sql 'select count(*) from drizzle.__drizzle_migrations')" 3 "applied migrations"

step "deploy v3 with a failing migration: stopped before anything restarts, v1 keeps serving"
if node scripts/deploy.mjs rehearsal --version v3; then echo "FAIL: v3 deployed" >&2; exit 1; fi
expect_api v1
expect_eq "$(sql 'select count(*) from drizzle.__drizzle_migrations')" 3 "applied migrations"
expect_eq "$(sed -n 's/^RELEASE_VERSION=//p' "$server/release.env")" v1 "current release"
probe
node scripts/deploy.mjs rehearsal --status

step "security headers through Caddy"
curl -fsS -o /dev/null -D - --cacert "$server/.caddy-root.crt" \
  --resolve "app.localhost:$HTTPS_PORT:127.0.0.1" "https://app.localhost:$HTTPS_PORT/" |
  grep -i -E '^(HTTP/|strict-transport|content-security|x-content-type|referrer-policy|server|alt-svc)'
curl -fsS -o /dev/null -w 'http -> %{http_code} %{redirect_url}\n' \
  --resolve "app.localhost:$HTTP_PORT:127.0.0.1" "http://app.localhost:$HTTP_PORT/"
echo
echo "REHEARSAL PASSED"
