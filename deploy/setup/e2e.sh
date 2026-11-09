#!/usr/bin/env bash
# End-to-end test of `pnpm run infra` (docs/setup.md "Tests", ADR 0032). A fresh Ubuntu "server"
# that has only root with a password, cloud-init's sshd drop-in and no Docker
# (deploy/setup/e2e/compose.yaml); the release images, built from this checkout, in a registry;
# Mailpit as the SMTP server to connect. Runs `infra --answers ci.answers.json --yes` (bootstrap,
# env, deploy, after-deploy steps, verify), runs it again (nothing changes, secrets kept), then
# `infra verify`, and checks the hardening from outside. Tears down; KEEP=1 keeps it running.
set -euo pipefail
cd "$(dirname "$0")/../.."
for tool in sops age-keygen docker ssh ssh-keygen curl jq ss; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done
export E2E_SSH_PORT=${E2E_SSH_PORT:-54022} E2E_HTTPS_PORT=${E2E_HTTPS_PORT:-54443}
export E2E_REGISTRY_PORT=${E2E_REGISTRY_PORT:-54500} E2E_MAILPIT_PORT=${E2E_MAILPIT_PORT:-54825}
for p in "$E2E_SSH_PORT" "$E2E_HTTPS_PORT" "$E2E_REGISTRY_PORT" "$E2E_MAILPIT_PORT"; do
  [ -z "$(ss -ltnH "sport = :$p")" ] || { echo "port $p is in use: abort" >&2; exit 1; }
done
work=$(mktemp -d "${E2E_TMP:-${TMPDIR:-/tmp}}/infra-e2e.XXXXXX")
answers=deploy/setup/e2e/ci.answers.json
reg=127.0.0.1:$E2E_REGISTRY_PORT/saas-infra
dc() { docker compose -f deploy/setup/e2e/compose.yaml "$@"; }
cleanup() {
  local rc=$?
  [ "$rc" = 0 ] || dc exec -T server sh -c 'cd /opt/saas-infra 2>/dev/null && docker compose ps -a && docker compose logs --tail 30' || true
  [ "${KEEP:-}" = 1 ] && { echo "kept: $work (dc down -v when done)"; return; }
  dc down -v -t 5 >/dev/null 2>&1 || true
  for i in api worker web; do docker image rm -f "$reg/$i:e2e" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '\n=== %s\n' "$*"; }

step "throwaway keys: ssh (the founder's key) and age"
ssh-keygen -q -t ed25519 -N '' -C infra-e2e -f "$work/id"
age-keygen -o "$work/age.key" 2>/dev/null
cat >"$work/ssh_config" <<CONF
Host infra-e2e
  HostName 127.0.0.1
  Port $E2E_SSH_PORT
  IdentityFile $work/id
  IdentitiesOnly yes
  UserKnownHostsFile $work/known_hosts
  StrictHostKeyChecking accept-new
CONF
export DEPLOY_SSH_CONFIG=$work/ssh_config DEPLOY_ENV_FILE=$work/e2e.enc.env REGISTRY_INSECURE=1
export SOPS_AGE_KEY_FILE=$work/age.key SOPS_AGE_RECIPIENTS=$(age-keygen -y "$work/age.key")
# the one connect secret, from the environment as in CI or a managed offering
export INFRA_SMTP_URL='smtp://10.54.54.11:1025?tls=none'

step "server (root + password, no Docker), registry, Mailpit"
dc up -d --build --wait
# what ssh-copy-id does on a real server (it needs the password typed)
dc exec -T server sh -c 'cat >/root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' <"$work/id.pub"

step "release images from this checkout -> registry"
docker build -q -f apps/api/Dockerfile --build-arg GIT_SHA=e2e -t "$reg/api:e2e" . >/dev/null
docker build -q -f services/worker-py/Dockerfile --build-arg GIT_SHA=e2e -t "$reg/worker:e2e" . >/dev/null
docker build -q -f apps/web/Dockerfile --build-arg VITE_RELEASE=e2e -t "$reg/web:e2e" . >/dev/null
for i in api worker web; do docker push -q "$reg/$i:e2e" >/dev/null; done

step "pnpm run infra -- --answers $answers --yes"
node scripts/infra.mjs --answers "$answers" --yes

step "again: nothing to change, generated secrets kept, the env file not rewritten"
sum=$(sha256sum <"$DEPLOY_ENV_FILE")
node scripts/infra.mjs --answers "$answers" --yes | tee "$work/rerun.log"
grep -q 'env keys: no change' "$work/rerun.log"
[ "$sum" = "$(sha256sum <"$DEPLOY_ENV_FILE")" ] || { echo "FAIL: env file rewritten" >&2; exit 1; }

step "pnpm run infra -- verify"
node scripts/infra.mjs verify --answers "$answers" --mail

step "hardening, seen from outside"
out=$(ssh -F "$work/ssh_config" -o BatchMode=yes -o PubkeyAuthentication=no root@infra-e2e true 2>&1 || :)
case $out in *"Permission denied (publickey)."*) echo "OK: only key login offered" ;; *) echo "FAIL: $out" >&2; exit 1 ;; esac
dc exec -T server sh -c 'sshd -T | grep -x "passwordauthentication no" && ufw status && id deploy'
curl -fsS -k --resolve "localhost:$E2E_HTTPS_PORT:127.0.0.1" "https://localhost:$E2E_HTTPS_PORT/api/auth/ok"
echo
# Umami's site opens only after its default admin login was replaced (sites/umami.ready)
code=$(curl -s -k -o /dev/null -w '%{http_code}' --resolve "umami.localhost:$E2E_HTTPS_PORT:127.0.0.1" \
  "https://umami.localhost:$E2E_HTTPS_PORT/api/heartbeat")
[ "$code" = 200 ] || { echo "FAIL: umami site answers $code" >&2; exit 1; }
echo "OK: umami site open after the admin step"
echo
curl -fsS "http://127.0.0.1:$E2E_MAILPIT_PORT/api/v1/search?query=subject:Self-check" |
  jq -e '.messages | length > 0' >/dev/null && echo "OK: the self-check mail arrived"
echo
echo "INFRA E2E PASSED"
