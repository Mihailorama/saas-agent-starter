#!/usr/bin/env node
// Secrets vault for humans and coding agents (docs/secrets.md). Wraps the official Bitwarden
// CLI `bw` (GPL-3.0, installed by the developer, run as an external program; never a dependency).
//   node scripts/vault.mjs status                      locked / unlocked / unauthenticated
//   node scripts/vault.mjs login                       BW_SERVER_URL + API key or prompt (human)
//   node scripts/vault.mjs unlock                      master password prompt -> session file (human)
//   node scripts/vault.mjs lock                        bw lock + delete the session file
//   node scripts/vault.mjs get <item> <field> | cmd    value to a pipe, never to a terminal
//   node scripts/vault.mjs run <item> <field> <VAR> -- cmd args   cmd with VAR=value in its env
//   printf %s "$v" | node scripts/vault.mjs put <item> <field>     value from stdin only
// <field>: username, password, notes, totp, or the name of a custom (hidden) field.
// The session key lives only in VAULT_SESSION_FILE (mode 0600, outside the repo) and reaches bw
// through its environment, never argv. Values never appear in argv, stdout (except get), stderr.
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
// bw only talks HTTPS; a private CA (the dev profile's Caddy) is trusted through this file.
const caFile = process.env.VAULT_CA_FILE ?? join(dir, 'ca.crt');
const LOCKED = `Vault is locked or not logged in. Agents: stop and ask a human to run
  node scripts/vault.mjs unlock
in their own terminal (login first if needed). Never look for the credential elsewhere.`;
const STANDARD = { username: 'login', password: 'login', totp: 'login', notes: 'item' };

const die = (msg, code = 1) => {
  process.stderr.write(`vault: ${msg}\n`);
  process.exit(code);
};

function session() {
  try {
    if (statSync(sessionFile).mode & 0o077) die(`${sessionFile} must be mode 0600`);
    return readFileSync(sessionFile, 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return process.env.BW_SESSION;
    throw e;
  }
}

/** Runs bw; stdout is returned, never printed. `secret` is masked in any error text. */
function bw(args, { input, secret, stdio = 'pipe' } = {}) {
  const env = { ...process.env, BW_SESSION: session() ?? '' };
  if (!env.BW_SESSION) delete env.BW_SESSION;
  if (existsSync(caFile)) env.NODE_EXTRA_CA_CERTS = caFile;
  const r = spawnSync('bw', args, {
    env,
    input,
    stdio,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error?.code === 'ENOENT') die('bw not found: install the Bitwarden CLI (docs/secrets.md)');
  if (r.status !== 0) {
    const err = (r.stderr ?? '').trim().split('\n')[0] || `bw ${args[0]} failed`;
    die(secret ? err.replaceAll(secret, '***') : err);
  }
  return r.stdout;
}

const status = () => JSON.parse(bw(['status', '--nointeraction']));
function requireUnlocked() {
  if (status().status !== 'unlocked') die(LOCKED, 2);
  bw(['sync', '--nointeraction']);
}

/** The one item named (or with the id) `name`, or undefined. */
function find(name) {
  const items = JSON.parse(bw(['list', 'items', '--search', name, '--nointeraction']));
  const hits = items.filter((i) => i.id === name || i.name === name);
  if (hits.length > 1) die(`${hits.length} items are named "${name}": use the item id`);
  return hits[0];
}

function read(item, field) {
  const where = STANDARD[field];
  const value =
    where === 'login'
      ? item.login?.[field]
      : where === 'item'
        ? item.notes
        : item.fields?.find((f) => f.name === field)?.value;
  if (value == null || value === '') die(`"${item.name}" has no ${field}`);
  return value;
}

function getValue(name, field) {
  requireUnlocked();
  const item = find(name);
  if (!item) die(`no item "${name}"`);
  return read(item, field);
}

function put(name, field, value) {
  requireUnlocked();
  const org = process.env.VAULT_ORGANIZATION_ID;
  const item = find(name) ?? {
    type: 1,
    name,
    notes: null,
    favorite: false,
    fields: [],
    login: { uris: [], username: null, password: null, totp: null },
    reprompt: 0,
    organizationId: org ?? null,
    collectionIds: org ? [process.env.VAULT_COLLECTION_ID].filter(Boolean) : null,
    folderId: null,
  };
  const where = STANDARD[field];
  if (where === 'login') item.login = { ...item.login, [field]: value };
  else if (where === 'item') item.notes = value;
  else {
    item.fields = (item.fields ?? []).filter((f) => f.name !== field);
    item.fields.push({ name: field, value, type: 1 }); // 1 = hidden
  }
  const input = Buffer.from(JSON.stringify(item)).toString('base64');
  const args = item.id ? ['edit', 'item', item.id] : ['create', 'item'];
  bw([...args, '--nointeraction'], { input, secret: value });
  process.stderr.write(`vault: saved ${field} of "${name}"\n`);
}

function unlock() {
  if (!process.stdin.isTTY) die('unlock is for a human at a terminal (master password prompt)');
  const st = status().status;
  if (st === 'unauthenticated') die('not logged in: run node scripts/vault.mjs login first');
  const key = bw(['unlock', '--raw'], { stdio: ['inherit', 'pipe', 'inherit'] }).trim();
  if (!key) die('unlock returned no session');
  mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, key, { mode: 0o600 });
  chmodSync(sessionFile, 0o600);
  process.stderr.write(`vault: unlocked, session in ${sessionFile}\n`);
}

function login() {
  const s = status();
  if (s.status === 'unauthenticated' && process.env.BW_SERVER_URL) {
    bw(['config', 'server', process.env.BW_SERVER_URL]);
  }
  if (s.status === 'unauthenticated') {
    // --apikey reads BW_CLIENTID / BW_CLIENTSECRET from the environment.
    const args = process.env.BW_CLIENTID ? ['login', '--apikey'] : ['login'];
    bw(args, { stdio: 'inherit' });
  }
  unlock();
}

const [cmd, item, field, ...rest] = process.argv.slice(2);
const need = (ok) => ok || die('usage: see the header of scripts/vault.mjs');
switch (cmd) {
  case 'status': {
    const s = status();
    console.log(`status: ${s.status}\nserver: ${s.serverUrl ?? 'bitwarden.com'}`);
    console.log(`user: ${s.userEmail ?? '-'}\nsession file: ${sessionFile}`);
    if (s.status !== 'unlocked') process.exitCode = 2;
    break;
  }
  case 'get':
    need(item && field);
    if (process.stdout.isTTY) die('get writes to a pipe only: get <item> <field> | <consumer>');
    process.stdout.write(getValue(item, field));
    break;
  case 'run': {
    const [name, dash, ...command] = rest;
    need(item && field && /^[A-Z_][A-Z0-9_]*$/.test(name ?? '') && dash === '--' && command.length);
    const value = getValue(item, field);
    const r = spawnSync(command[0], command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, [name]: value },
    });
    process.exit(r.status ?? 1);
    break;
  }
  case 'put': {
    need(item && field);
    if (process.stdin.isTTY) die('put reads the value from stdin: printf %s "$v" | put ...');
    const value = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (!value) die('empty value on stdin');
    put(item, field, value);
    break;
  }
  case 'unlock':
    unlock();
    break;
  case 'login':
    login();
    break;
  case 'lock':
    bw(['lock']);
    rmSync(sessionFile, { force: true });
    process.stderr.write('vault: locked\n');
    break;
  default:
    need(false);
}
