#!/usr/bin/env node
// Secrets vault for humans and coding agents (docs/secrets.md). Wraps the official Bitwarden
// CLI `bw` (GPL-3.0, installed by the developer, run as an external program; never a dependency).
//   node scripts/vault.mjs status                       locked / unlocked / unauthenticated
//   node scripts/vault.mjs unlock                       master password prompt (human, terminal)
//   node scripts/vault.mjs lock                         delete the session, bw lock
//   node scripts/vault.mjs get <item> <field> --stdout | cmd    value to a pipe, explicit opt-in
//   node scripts/vault.mjs run <item> <field> <VAR> -- cmd args  cmd with VAR=value, no BW_* env
//   <producer> | node scripts/vault.mjs put <item> <field>       new field only, value from stdin
//   <producer> | node scripts/vault.mjs replace <item> <field>   overwrite an existing field
// <field>: a custom field (saved hidden), or the login's username / password, or notes.
// bw runs with its own profile (VAULT_BW_DIR, default ~/.config/agent-vault/bw), never the
// human's: log that profile in as a dedicated agent account (docs/secrets.md). The session key
// lives only in VAULT_SESSION_FILE (0600) and reaches bw through its environment, never argv.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const dir = join(homedir(), '.config', 'agent-vault');
const sessionFile = process.env.VAULT_SESSION_FILE ?? join(dir, 'session');
const bwDir = process.env.VAULT_BW_DIR ?? join(dir, 'bw');
// bw only talks HTTPS; a private CA (the dev profile's Caddy) is trusted through this file.
const caFile = process.env.VAULT_CA_FILE ?? join(dir, 'ca.crt');
const LOCKED = `Vault is locked or not logged in. Agents: stop and ask a human to run
  node scripts/vault.mjs unlock
in their own terminal (login first, docs/secrets.md). Never look for the credential elsewhere.`;

const die = (msg, code = 1) => {
  process.stderr.write(`vault: ${msg}\n`);
  process.exit(code);
};

/** process.env without BW_* (the human's session, API key, server): never passed on. */
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BW_')));

function session() {
  if (!existsSync(sessionFile)) return undefined;
  if (statSync(sessionFile).mode & 0o077) die(`${sessionFile} must be mode 0600`);
  return readFileSync(sessionFile, 'utf8').trim();
}

/** Runs bw in the agent profile; stdout is returned, never printed. `secret` is masked. */
function bw(args, { input, secret, stdio = 'pipe' } = {}) {
  const env = { ...cleanEnv(), BITWARDENCLI_APPDATA_DIR: bwDir };
  const key = session();
  if (key) env.BW_SESSION = key;
  if (existsSync(caFile)) env.NODE_EXTRA_CA_CERTS = caFile;
  const r = spawnSync('bw', args, { env, input, stdio, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error?.code === 'ENOENT') die('bw not found: install the Bitwarden CLI (docs/secrets.md)');
  if (r.status !== 0) {
    const err = (r.stderr ?? '').trim().split('\n')[0] || `bw ${args[0]} failed`;
    die(secret ? err.replaceAll(secret, '***') : err);
  }
  return r.stdout;
}

const status = () => JSON.parse(bw(['status', '--nointeraction']));

/** Unlocked and synced, then the one item named (or with the id) `name`, or undefined. */
function find(name) {
  if (status().status !== 'unlocked') die(LOCKED, 2);
  bw(['sync', '--nointeraction']);
  // `bw get item` fails when the name is a prefix of another item's name, so list + exact match.
  const items = JSON.parse(bw(['list', 'items', '--search', name, '--nointeraction']));
  const hits = items.filter((i) => i.id === name || i.name === name);
  if (hits.length > 1) die(`${hits.length} items are named "${name}": use the item id`);
  return hits[0];
}

const LOGIN = new Set(['username', 'password']);
const lookup = (item, field) =>
  item?.fields?.find((f) => f.name === field)?.value ??
  (field === 'notes' ? item?.notes : LOGIN.has(field) ? item?.login?.[field] : undefined);

function getValue(name, field) {
  const value = lookup(find(name), field);
  if (value == null || value === '') die(`no ${field} in "${name}"`);
  return value;
}

function put(name, field, value, replace) {
  const found = find(name);
  const had = lookup(found, field) != null;
  if (had && !replace) die(`"${name}" already has ${field}: a human runs replace to overwrite`);
  if (!had && replace) die(`"${name}" has no ${field} to replace: use put`);
  const item = found ?? {
    type: 1,
    name,
    notes: null,
    fields: [],
    login: { uris: [], username: null, password: null, totp: null },
    organizationId: process.env.VAULT_ORGANIZATION_ID ?? null,
    collectionIds: process.env.VAULT_COLLECTION_ID ? [process.env.VAULT_COLLECTION_ID] : null,
  };
  if (field === 'notes') item.notes = value;
  else if (LOGIN.has(field) && !item.fields?.some((f) => f.name === field)) {
    item.login = { ...item.login, [field]: value };
  } else {
    item.fields = (item.fields ?? []).filter((f) => f.name !== field);
    item.fields.push({ name: field, value, type: 1 }); // 1 = hidden
  }
  const input = Buffer.from(JSON.stringify(item)).toString('base64');
  bw([...(item.id ? ['edit', 'item', item.id] : ['create', 'item']), '--nointeraction'], {
    input,
    secret: value,
  });
  process.stderr.write(`vault: saved ${field} of "${name}"\n`);
}

function unlock() {
  if (!process.stdin.isTTY) die('unlock is for a human at a terminal (master password prompt)');
  if (status().status === 'unauthenticated') die('not logged in: see docs/secrets.md "Log in"');
  const key = bw(['unlock', '--raw'], { stdio: ['inherit', 'pipe', 'inherit'] }).trim();
  if (!key) die('unlock returned no session');
  mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, key, { mode: 0o600 });
  chmodSync(sessionFile, 0o600);
  process.stderr.write(`vault: unlocked, session in ${sessionFile}\n`);
}

const [cmd, item, field, ...rest] = process.argv.slice(2);
const need = (ok) => ok || die('usage: see the header of scripts/vault.mjs');
switch (cmd) {
  case 'status': {
    const s = status();
    console.log(`status: ${s.status}\nserver: ${s.serverUrl ?? 'bitwarden.com'}`);
    console.log(`user: ${s.userEmail ?? '-'}\nbw profile: ${bwDir}`);
    if (s.status !== 'unlocked') process.exitCode = 2;
    break;
  }
  case 'get':
    need(item && field);
    if (rest[0] !== '--stdout' || process.stdout.isTTY) {
      die('get prints the value only with --stdout into a pipe: get <item> <field> --stdout | cmd');
    }
    process.stdout.write(getValue(item, field));
    break;
  case 'run': {
    const [name, dash, ...command] = rest;
    need(item && field && /^[A-Z_][A-Z0-9_]*$/.test(name ?? '') && dash === '--' && command.length);
    if (name.startsWith('BW_')) die('BW_* names are reserved');
    const value = getValue(item, field);
    const r = spawnSync(command[0], command.slice(1), {
      stdio: 'inherit',
      env: { ...cleanEnv(), [name]: value },
    });
    process.exit(r.status ?? 1);
    break;
  }
  case 'put':
  case 'replace': {
    need(item && field);
    if (process.stdin.isTTY) die(`${cmd} reads the value from stdin: <producer> | ${cmd} ...`);
    const value = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (!value) die('empty value on stdin');
    put(item, field, value, cmd === 'replace');
    break;
  }
  case 'unlock':
    unlock();
    break;
  case 'lock':
    rmSync(sessionFile, { force: true });
    bw(['lock']);
    process.stderr.write('vault: locked\n');
    break;
  default:
    need(false);
}
