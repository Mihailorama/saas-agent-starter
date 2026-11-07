#!/usr/bin/env node
// pnpm run deploy -- <env> --version <tag>   deploy a release (images pinned by digest)
// pnpm run deploy -- <env> --rollback        back to the previous release's digests
// pnpm run deploy -- <env> --status          what runs there now
//
// Decrypts deploy/env/<env>.enc.env with sops in memory (key: SOPS_AGE_KEY_FILE or SOPS_AGE_KEY),
// then runs docker compose on DEPLOY_HOST over SSH, or on this machine with DEPLOY_HOST=local.
// Secrets travel only on the stdin of `ssh ... sh -s`: never in argv, never printed.
// Design and server layout: docs/deploy.md, ADR 0016.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

process.chdir(new URL('..', import.meta.url).pathname);
const USAGE = 'usage: pnpm run deploy -- <env> (--version <tag> | --rollback | --status)';
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
const args = process.argv.slice(2).filter((a) => a !== '--');
const [envName] = args;
const at = args.indexOf('--version');
const version = at > 0 ? args[at + 1] : undefined;
const mode = args.includes('--rollback')
  ? 'rollback'
  : args.includes('--status')
    ? 'status'
    : 'deploy';
if (!/^[a-z0-9][a-z0-9-]*$/.test(envName ?? '')) die(USAGE);
if (mode === 'deploy' && !version && !process.env.IMAGE_API) die(USAGE);

// --- configuration: the decrypted env file (process env wins for the DEPLOY_* target keys) ---
const file = process.env.DEPLOY_ENV_FILE ?? `deploy/env/${envName}.enc.env`;
const secrets = execFileSync(
  'sops',
  ['decrypt', '--input-type', 'dotenv', '--output-type', 'dotenv', file],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
const env = Object.fromEntries(
  secrets.split('\n').flatMap((l) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    return m ? [[m[1], m[2]]] : [];
  }),
);
const cfg = (key, fallback) => {
  const value = process.env[key] ?? env[key] ?? fallback;
  if (value === undefined) die(`${key} is not set in ${file}`);
  return value;
};
const host = cfg('DEPLOY_HOST');
const project = cfg('COMPOSE_PROJECT_NAME');
const dir = cfg('DEPLOY_PATH', `/opt/${project}`);
const domain = cfg('APP_DOMAIN');
const internalCa = cfg('CADDY_TLS') === 'internal';
const port = cfg('HTTPS_PORT', '443');
const ip = [undefined, '', '0.0.0.0'].includes(env.PUBLISH_IP) ? '127.0.0.1' : env.PUBLISH_IP;

// --- the release: one digest per app image ---
function digest(name) {
  const pinned = process.env[`IMAGE_${name.toUpperCase()}`];
  if (pinned) {
    if (!pinned.includes('@sha256:')) die(`IMAGE_${name.toUpperCase()} must be pinned by digest`);
    return pinned;
  }
  const repo = `${cfg('IMAGE_REPO').toLowerCase()}/${name}`;
  const ref = `${repo}:${version}`;
  const sh = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
  // Remote targets pull from the registry, so its digest is the truth; DEPLOY_HOST=local
  // (rehearsals, air-gapped hosts after `docker load`) uses the image already in the daemon.
  if (host === 'local') {
    const local = JSON.parse(sh('image', 'inspect', '--format', '{{json .RepoDigests}}', ref));
    const hit = local.find((d) => d.startsWith(`${repo}@`));
    if (!hit) die(`${ref} has no digest in the local daemon`);
    return hit;
  }
  const manifest = JSON.parse(
    sh('buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', ref),
  );
  return `${repo}@${manifest.digest}`;
}

// --- the scripts that run on the target (POSIX sh, reads .env via docker compose) ---
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const put = (name, content) =>
  `printf %s ${q(Buffer.from(content).toString('base64'))} | base64 -d > ${q(name)}`;
const FILES = {
  'compose.yaml': 'compose.prod.yaml',
  Caddyfile: 'deploy/Caddyfile',
  'temporal-setup.sh': 'infra/temporal/setup-postgres.sh',
  'temporal-dynamicconfig.yaml': 'infra/temporal/dynamicconfig.yaml',
};
const url = `https://${domain}:${port}/api/auth/ok`;
const head = `set -eu
mkdir -p ${q(dir)} && cd ${q(dir)}
`;
// Up, reload Caddy (picks up an edited Caddyfile without dropping connections), then probe the
// public URL through Caddy -> web -> api from the host itself.
const up = `docker compose up -d --wait --wait-timeout 600 --remove-orphans
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
  { echo "caddy reload failed: check the Caddyfile (docker compose logs caddy)" >&2; exit 1; }
i=0
until curl -fs -o /dev/null --max-time 5 --resolve ${q(`${domain}:${port}:${ip}`)} \\
  ${internalCa ? '--cacert .caddy-root.crt' : ''} ${q(url)}; do
  ${internalCa ? 'docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > .caddy-root.crt 2>/dev/null || true' : ':'}
  i=$((i + 1)); [ "$i" -lt 45 ] || { echo "health check failed: ${url}" >&2; exit 1; }; sleep 2
done
echo "healthy: ${url}"
cp release.env release.good.env
docker compose ps --format 'table {{.Service}}\\t{{.Image}}\\t{{.Status}}'
`;
const log = (action) =>
  `printf '%s %s %s\\n' "$(date -u +%FT%TZ)" ${q(action)} "$(tr '\\n' ' ' < release.env)" >> deploy.log\n`;

function run(script, { status = false } = {}) {
  const sh = host === 'local' ? ['sh', ['-s']] : ['ssh', ['-o', 'BatchMode=yes', host, 'sh -s']];
  const code = spawnSync(...sh, { input: script, stdio: ['pipe', 'inherit', 'inherit'] }).status;
  return status ? code : code === 0;
}

if (mode === 'status') {
  process.exit(run(`${head}docker compose ps; cat release.env; tail -n 5 deploy.log`) ? 0 : 1);
}

if (mode === 'rollback') {
  console.log(`rolling back ${envName} on ${host}`);
  const ok =
    run(`${head}[ -f release.prev.env ] || { echo "no previous release in ${dir}" >&2; exit 1; }
mv release.env release.tmp && mv release.prev.env release.env && mv release.tmp release.prev.env
(umask 077; cat secrets.env release.env > .env)
cat release.env
${up}${log('rollback')}`);
  process.exit(ok ? 0 : 1);
}

const images = { api: digest('api'), worker: digest('worker'), web: digest('web') };
const release = `${Object.entries(images)
  .map(([k, v]) => `IMAGE_${k.toUpperCase()}=${v}`)
  .join('\n')}\nRELEASE_VERSION=${version ?? 'pinned'}\n`;
console.log(`deploying ${version ?? 'pinned images'} to ${envName} on ${host}\n${release}`);

// Phase 1: stage the new files as *.next and pull the images. Nothing running changes, so a
// failure here needs no rollback.
const staged = `${head}umask 022
${Object.entries(FILES)
  .map(([to, from]) => put(`${to}.next`, readFileSync(from)))
  .join('\n')}
${put('release.env.next', release)}
(umask 077; ${put('secrets.env.next', secrets)})
(umask 077; cat secrets.env.next release.env.next > .env.next)
docker compose -f compose.yaml.next --env-file .env.next pull --quiet --policy missing
`;
if (!run(staged)) die('staging failed; nothing was changed on the target');

// ------------------------------------------------------------------------------------------
// PRE-MIGRATION BACKUP HOOK. `pnpm run backup:now` comes from the backups branch; until it
// lands this warns and continues. TODO(docs/TODO.md): make it mandatory (fail without it).
// ------------------------------------------------------------------------------------------
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};
if (scripts['backup:now']) {
  const backup = spawnSync('pnpm', ['run', 'backup:now'], {
    stdio: 'inherit',
    env: { ...process.env, DEPLOY_ENV: envName },
  });
  if (backup.status !== 0) die('backup failed; nothing was changed on the target');
} else {
  console.warn('WARNING: no `backup:now` script yet: deploying WITHOUT a pre-migration backup.');
}

// Phase 2: swap the files in place (same inode, so the mounted Caddyfile updates) and make the
// last release that passed its health check the rollback target (never a failed one). Then the
// migration runs as a one-off container BEFORE `up`: `up` recreates api/worker/web (removing the
// old containers) before it waits for the migrate service, so a failing migration inside `up`
// would take the running release down. If it fails, the release state goes back (exit 3).
const code = run(
  `${head}[ ! -f release.good.env ] || cp release.good.env release.prev.env
for f in ${Object.keys(FILES).join(' ')} release.env; do cat "$f.next" > "$f"; rm "$f.next"; done
umask 077
cat secrets.env.next > secrets.env; rm secrets.env.next .env.next
cat secrets.env release.env > .env; chmod 600 secrets.env .env
if ! docker compose run --rm -T migrate; then
  [ ! -f release.good.env ] || { cp release.good.env release.env; cat secrets.env release.env > .env; }
  ${log(`migration failed ${version ?? 'pinned'}`).trim()}
  exit 3
fi
${up}${log(`deploy ${version ?? 'pinned'}`)}`,
  { status: true },
);
if (code === 3) {
  die(
    'migration failed: nothing was restarted and the previous release stays current. The database\n' +
      'is unchanged (drizzle applies pending migrations in one transaction). Fix it, release again.',
  );
}
if (code !== 0) {
  die(
    `deploy failed after the migration. Some services may run the new release.\n` +
      `Roll back: pnpm run deploy -- ${envName} --rollback`,
  );
}
