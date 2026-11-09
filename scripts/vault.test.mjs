// node --test 'scripts/*.test.mjs'. scripts/vault.mjs against a fake `bw` first on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const SECRET = 'local-dev-fake-value'; // must never leak into argv, stdout or stderr
const fakeBw = `#!/usr/bin/env node
const fs = require('node:fs');
const fail = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const e = process.env, a = process.argv.slice(2);
fs.appendFileSync(e.FAKE_BW_ARGV, JSON.stringify(a) + '\\n');
if (e.BITWARDENCLI_APPDATA_DIR !== e.FAKE_BW_PROFILE) fail('not the agent profile');
if (Object.keys(e).some((k) => k.startsWith('BW_') && k !== 'BW_SESSION')) fail('BW_* leaked');
const s = JSON.parse(fs.readFileSync(e.FAKE_BW_STORE, 'utf8'));
const save = () => fs.writeFileSync(e.FAKE_BW_STORE, JSON.stringify(s));
const open = s.loggedIn && e.BW_SESSION === s.session;
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const stdin = () => fs.readFileSync(0, 'utf8');
const line = () => { // a terminal gives no EOF: read up to the newline
  let l = ''; const b = Buffer.alloc(1);
  while (fs.readSync(0, b) === 1 && b[0] !== 10) l += String.fromCharCode(b[0]);
  return l.trim();
};
switch (a[0]) {
  case 'status': out({ serverUrl: 'http://vault.example.com', userEmail: 'dev@example.com',
    status: !s.loggedIn ? 'unauthenticated' : open ? 'unlocked' : 'locked' }); break;
  case 'sync': if (!open) fail('Vault is locked.'); out('Syncing complete.'); break;
  case 'list': if (!open) fail('Vault is locked.');
    out(s.items.filter((i) => i.name.includes(a[3]))); break;
  case 'create': case 'edit': {
    if (!open) fail('Vault is locked.');
    const item = JSON.parse(Buffer.from(stdin(), 'base64').toString());
    if (a[0] === 'create') { item.id = 'id-' + s.items.length; s.items.push(item); }
    else s.items[s.items.findIndex((i) => i.id === a[2])] = item;
    save(); out(item); break; // like bw: the item, secrets included, on stdout
  }
  case 'unlock': process.stderr.write('? Master password: [input is hidden]\\n');
    if (line() !== s.password) fail('Invalid master password.');
    out(s.session); break;
  case 'lock': out('Your vault is locked.'); break;
  default: fail('unknown');
}
`;

function setup(store = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-test-'));
  writeFileSync(join(dir, 'bw'), fakeBw, { mode: 0o755 });
  const sessionFile = join(dir, 'state', 'session');
  const files = { store: join(dir, 'store.json'), argv: join(dir, 'argv.log') };
  const data = { loggedIn: true, session: 'sess-key-1', password: 'pw', items: [], ...store };
  writeFileSync(files.store, JSON.stringify(data));
  writeFileSync(files.argv, '');
  const env = {
    PATH: `${dir}:${process.env.PATH}`,
    HOME: dir,
    VAULT_SESSION_FILE: sessionFile,
    FAKE_BW_STORE: files.store,
    FAKE_BW_ARGV: files.argv,
    FAKE_BW_PROFILE: join(dir, '.config', 'agent-vault', 'bw'),
    // the human's own bw state: must never reach bw or a `run` child
    BW_SESSION: 'human-session',
    BW_CLIENTSECRET: 'human-client-secret',
  };
  const vault = (args, input) =>
    spawnSync(process.execPath, ['scripts/vault.mjs', ...args], { env, input, encoding: 'utf8' });
  return {
    env,
    vault,
    sessionFile,
    unlocked: () => {
      mkdirSync(dirname(sessionFile), { recursive: true });
      writeFileSync(sessionFile, data.session, { mode: 0o600 });
    },
    items: () => JSON.parse(readFileSync(files.store, 'utf8')).items,
    argv: () => readFileSync(files.argv, 'utf8'),
  };
}
const noLeak = (...outputs) => {
  for (const o of outputs) assert.ok(!o.includes(SECRET), 'value leaked');
};

test('put adds new fields from stdin; existing ones need replace', () => {
  const t = setup();
  t.unlocked();
  const r = t.vault(['put', 'stripe/test', 'STRIPE_KEY'], `${SECRET}\n`);
  assert.equal(r.status, 0, r.stderr);
  noLeak(r.stdout, r.stderr, t.argv());
  assert.deepEqual(t.items()[0].fields, [{ name: 'STRIPE_KEY', value: SECRET, type: 1 }]);

  const again = t.vault(['put', 'stripe/test', 'STRIPE_KEY'], 'other');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has STRIPE_KEY: a human runs replace/);
  assert.equal(t.items()[0].fields[0].value, SECRET, 'not overwritten');

  assert.equal(t.vault(['put', 'stripe/test', 'password'], 'pw-2').status, 0);
  assert.equal(t.items().length, 1, 'same item, edited');
  assert.equal(t.items()[0].login.password, 'pw-2');
  assert.equal(t.vault(['put', 'stripe/test', 'password'], 'pw-3').status, 1);

  const rep = t.vault(['replace', 'stripe/test', 'STRIPE_KEY'], 'rotated');
  assert.equal(rep.status, 0, rep.stderr);
  assert.deepEqual(t.items()[0].fields, [{ name: 'STRIPE_KEY', value: 'rotated', type: 1 }]);
  assert.equal(t.vault(['replace', 'stripe/test', 'NEW'], 'x').status, 1, 'replace needs a field');
});

test('get prints only with --stdout; run strips BW_* from the child env', () => {
  const item = { id: 'id-0', name: 'stripe/test', fields: [{ name: 'k', value: SECRET }] };
  const t = setup({ items: [item, { id: 'id-1', name: 'stripe/test-old', fields: [] }] });
  t.unlocked();
  const bare = t.vault(['get', 'stripe/test', 'k']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /only with --stdout/);
  noLeak(bare.stdout, bare.stderr);

  const r = t.vault(['get', 'stripe/test', 'k', '--stdout']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, SECRET);
  assert.equal(r.stderr, '');
  noLeak(t.argv());

  const check = `const e = process.env; process.exit(e.KEY === ${JSON.stringify(SECRET)} &&
    !Object.keys(e).some((k) => k.startsWith('BW_')) ? 0 : 3)`;
  const run = t.vault(['run', 'stripe/test', 'k', 'KEY', '--', process.execPath, '-e', check]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(t.vault(['run', 'stripe/test', 'k', 'BW_X', '--', 'true']).status, 1);

  const missing = t.vault(['get', 'stripe/test', 'nope', '--stdout']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no nope/);
});

test('a locked vault (the human session does not count) is exit 2 and a clear error', () => {
  const t = setup({ items: [{ id: 'id-0', name: 'x', login: { password: SECRET } }] });
  for (const args of [['get', 'x', 'password', '--stdout'], ['put', 'x', 'y'], ['status']]) {
    const r = t.vault(args, 'new-value');
    assert.equal(r.status, 2, args.join(' '));
    noLeak(r.stdout, r.stderr);
  }
  const r = t.vault(['get', 'x', 'password', '--stdout']);
  assert.match(r.stderr, /locked.*\n.*vault\.mjs unlock/);
  assert.match(r.stderr, /Never look for the credential elsewhere/);
});

test('session file: refused when readable by others, deleted by lock', () => {
  const t = setup();
  t.unlocked();
  chmodSync(t.sessionFile, 0o644);
  assert.match(t.vault(['status']).stderr, /must be mode 0600/);
  chmodSync(t.sessionFile, 0o600);
  assert.equal(t.vault(['lock']).status, 0);
  assert.ok(!existsSync(t.sessionFile));
});

test('Claude Code may run only status and lock without asking', () => {
  const { allow, deny } = JSON.parse(readFileSync('.claude/settings.json', 'utf8')).permissions;
  const vault = allow.filter((p) => p.includes('vault.mjs') || /\bbw\b/.test(p));
  assert.deepEqual(vault, [
    'Bash(node scripts/vault.mjs status)',
    'Bash(node scripts/vault.mjs lock)',
  ]);
  for (const d of ['Bash(bw get *)', 'Bash(bw list *)', 'Bash(bw export *)']) {
    assert.ok(deny.includes(d), d);
  }
});

test('unlock stores the session key in a 0600 file, never printing it', {
  skip: process.platform !== 'linux' && 'needs util-linux script(1) for a terminal',
}, () => {
  const t = setup();
  const cmd = `${process.execPath} scripts/vault.mjs unlock`;
  const r = spawnSync('script', ['-qec', cmd, '/dev/null'], {
    env: t.env,
    input: 'pw\n',
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.stdout.includes('sess-key-1'), 'session key not printed');
  assert.equal(readFileSync(t.sessionFile, 'utf8'), 'sess-key-1');
  assert.equal(statSync(t.sessionFile).mode & 0o777, 0o600);
  assert.ok(!readFileSync(t.env.FAKE_BW_ARGV, 'utf8').includes('sess-key-1'));
  assert.equal(t.vault(['status']).status, 0);
});
