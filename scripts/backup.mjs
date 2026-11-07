#!/usr/bin/env node
// `pnpm run backup:now [-- --type full|diff|incr]` and
// `pnpm run restore [-- --target-time <iso>] [--in-place --yes-overwrite-live]`.
// Drives the containers of compose.backup.yaml (runbook: docs/backups.md). Default restore target
// is a NEW instance (`postgres-restore`); the live database is only overwritten with both flags.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** ISO 8601 with an explicit offset -> pgBackRest/Postgres target time ("... +00"). */
export function targetTime(iso, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    throw new Error(`--target-time must be ISO 8601 with a time zone, e.g. 2026-11-07T10:00:00Z`);
  }
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) throw new Error(`invalid --target-time: ${iso}`);
  if (t > now) throw new Error(`--target-time ${iso} is in the future`);
  return t.toISOString().replace('T', ' ').replace('Z', '+00');
}

export function parse(argv, now) {
  const [command, ...rest] = argv.filter((a) => a !== '--');
  const { values } = parseArgs({
    args: rest,
    options: {
      type: { type: 'string', default: 'full' },
      'target-time': { type: 'string' },
      'in-place': { type: 'boolean', default: false },
      'yes-overwrite-live': { type: 'boolean', default: false },
    },
  });
  if (command === 'now') {
    if (!['full', 'diff', 'incr'].includes(values.type)) throw new Error('--type: full|diff|incr');
    return { command, type: values.type };
  }
  if (command !== 'restore') throw new Error('usage: backup.mjs now|restore [options]');
  if (values['in-place'] !== values['yes-overwrite-live']) {
    throw new Error('overwriting the live database needs both --in-place and --yes-overwrite-live');
  }
  const target = values['target-time'] && targetTime(values['target-time'], now);
  return { command, inPlace: values['in-place'], target };
}

const env = { COMPOSE_FILE: 'docker-compose.yml:compose.backup.yaml', ...process.env };
/** docker compose; output streams to the terminal unless `capture` (then it is returned). */
const compose = (args, capture = false) =>
  execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  });
const asPostgres = ['run', '--rm', '--no-deps', '-T', '--user', 'postgres', '--entrypoint'];
const waitPromoted = (svc) =>
  compose([
    'exec',
    '-T',
    svc,
    'sh',
    '-c',
    'until [ "$(psql -U postgres -tAc "select pg_is_in_recovery()")" = f ]; do sleep 1; done',
  ]);
// Repository storage and metrics keep running during an in-place restore.
const KEEP = new Set(['backup-s3', 'pushgateway']);

function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.command === 'now') {
    compose(['exec', '-T', 'backup', '/backup/bin/backup.sh', opts.type]);
    return;
  }
  const restoreArgs = opts.target ? ['--target-time', opts.target] : [];
  if (!opts.inPlace) {
    const svc = ['--profile', 'restore'];
    compose([...svc, 'rm', '--stop', '--force', 'postgres-restore']);
    compose([
      ...svc,
      ...asPostgres,
      '/backup/bin/restore.sh',
      'postgres-restore',
      ...restoreArgs,
      '--new-instance',
    ]);
    compose([...svc, 'up', '--detach', '--wait', 'postgres-restore']);
    const port = process.env.RESTORE_POSTGRES_PORT ?? '5433';
    console.log(`restored copy ready: postgres://postgres:postgres@localhost:${port}/app`);
    return;
  }
  const running = compose(['ps', '--services', '--status', 'running'], true)
    .split('\n')
    .filter((s) => s && !KEEP.has(s));
  console.log(`stopping ${running.join(', ') || 'nothing'}; restoring the live database in place`);
  if (running.length) compose(['stop', ...running]);
  compose([...asPostgres, '/backup/bin/restore.sh', 'postgres', '--in-place', ...restoreArgs]);
  compose(['up', '--detach', '--wait', 'postgres']);
  waitPromoted('postgres');
  compose(['up', '--detach', '--wait', ...new Set([...running, 'backup'])]);
  console.log('live database restored. Take a new full backup now: pnpm run backup:now');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
