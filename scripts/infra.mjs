#!/usr/bin/env node
// One-command infrastructure setup (docs/setup.md, ADR 0032). Components: config/components.json.
//   pnpm run infra [-- <env>]                    questions, then bootstrap, deploy, verify
//   pnpm run infra -- plan [<env>]               (or --dry-run) what would change; changes nothing
//   pnpm run infra -- add <component> [<env>]    ask about one component, then apply
//   pnpm run infra -- verify [<env>] [--org <id>]  health probe + each component's check
// Options: --answers <file> (default deploy/setup/<env>.answers.json; <env> default production),
// --yes (no questions: connect secrets from INFRA_<KEY> variables, or KEY=value lines on stdin
// with --secrets-stdin), --rotate <KEY> (repeatable: regenerate a generated secret).
// The answers file holds choices, hosts and URLs, never a secret. Secrets go only into
// deploy/env/<env>.enc.env (DEPLOY_ENV_FILE), piped into sops on stdin. Nothing prints a value:
// plans show key names. SSH: your ssh config and agent (DEPLOY_SSH_CONFIG: another config file).
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
export const catalog = JSON.parse(read('config/components.json')).components;
const byId = Object.fromEntries(catalog.map((c) => [c.id, c]));
const models = JSON.parse(read('config/ai-models.json'));
const UPSTREAM = 'ghcr.io/mihailorama/saas-agent-starter'; // until a fork has its own release
const SOPS_PLACEHOLDER = 'age1replace-with-your-public-key';
const LABEL = {
  install: 'install on the server',
  connect: 'connect an existing one',
  skip: 'skip',
};

const die = (msg) => {
  console.error(`infra: ${msg}`);
  process.exit(1);
};
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

export function parseDotenv(text) {
  return Object.fromEntries(
    text.split('\n').flatMap((l) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
      return m ? [[m[1], m[2]]] : [];
    }),
  );
}
const toDotenv = (env) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');

export const modeOf = (a, c) =>
  c.modes.length === 1 ? c.modes[0] : (a.components?.[c.id]?.mode ?? 'skip');

/** Allowed values of the LLM fields, from config/ai-models.json (API providers only). */
function choices(key, ca) {
  if (key === 'AI_CONTOUR') return Object.keys(models.contours);
  const rows = (models.contours[ca.AI_CONTOUR] ?? []).filter(
    (r) => r.purposes.includes('project.summary') && models.providers[r.provider]?.kind !== 'cli',
  );
  if (key === 'AI_PROJECT_SUMMARY_PROVIDER') return [...new Set(rows.map((r) => r.provider))];
  if (key === 'AI_PROJECT_SUMMARY_MODEL')
    return rows.filter((r) => r.provider === ca.AI_PROJECT_SUMMARY_PROVIDER).map((r) => r.model);
}

/** A connect field; `@apiKey` becomes the chosen provider's key (and base URL) variables. */
function expandField(f, ca) {
  if (f.key !== '@apiKey') return [f];
  const p = models.providers[ca.AI_PROJECT_SUMMARY_PROVIDER] ?? {};
  return [
    ...(p.baseUrlEnv
      ? [{ key: p.baseUrlEnv, prompt: 'Base URL of the endpoint', validate: '^https?://' }]
      : []),
    ...(p.apiKeyEnv ? [{ ...f, key: p.apiKeyEnv }] : []),
  ];
}
const fields = (c, ca) => (c.connect ?? []).flatMap((f) => expandField(f, ca ?? {}));

export function validateAnswers(a) {
  const errors = [];
  const need = (ok, msg) => ok || errors.push(msg);
  const name = /^[a-z_][a-z0-9_-]*$/;
  need(/^[a-z0-9][a-z0-9-]*$/.test(a.env ?? ''), 'env: lowercase letters, digits and dashes');
  need(/^[\w.-]+$/.test(a.server?.host ?? ''), 'server.host: an IP, host name or ssh alias');
  need(name.test(a.server?.admin ?? ''), 'server.admin: root, or a user with passwordless sudo');
  need(name.test(a.server?.user ?? ''), 'server.user: name of the deploy user');
  need(name.test(a.project ?? ''), 'project: compose project name');
  need(/^([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(a.domain ?? ''), 'domain: e.g. app.example.com');
  need(a.tls === 'internal' || /^[^@\s]+@[^@\s]+$/.test(a.tls ?? ''), 'tls: e-mail or internal');
  need(/^[a-z0-9][\w.:/-]*$/.test(a.images?.repo ?? ''), 'images.repo: registry/owner/name');
  need(/^\w[\w.-]*$/.test(a.images?.version ?? ''), 'images.version: a release tag, e.g. v1.0.0');
  for (const c of catalog) {
    const ca = a.components?.[c.id];
    if (!ca) {
      need(c.tier !== 'core' || c.modes.length === 1, `components.${c.id}: ${c.modes.join('|')}`);
      continue;
    }
    const at = `components.${c.id}`;
    if (!c.modes.includes(ca.mode)) {
      errors.push(`${at}.mode: one of ${c.modes.join(', ')}`);
      continue;
    }
    need(ca.mode === 'skip' || c.available !== false, `${at}: not available yet (docs/TODO.md)`);
    for (const r of c.requires?.[ca.mode] ?? []) {
      const [id, mode] = r.split(':');
      need(modeOf(a, byId[id]) === mode, `${at}: ${ca.mode} needs ${id} ${mode}`);
    }
    for (const f of fields(c, ca)) {
      const v = ca[f.key];
      if (f.secret) {
        need(v === undefined, `${at}.${f.key}: a secret, never in answers (use INFRA_${f.key})`);
      } else if (ca.mode === 'connect') {
        need(v !== undefined || f.default !== undefined, `${at}.${f.key}: missing (${f.prompt})`);
        if (v === undefined) continue;
        const allowed = choices(f.key, ca);
        need(!allowed || allowed.includes(v), `${at}.${f.key}: one of ${allowed?.join(', ')}`);
        need(!f.validate || new RegExp(f.validate).test(v), `${at}.${f.key}: ${f.prompt}`);
      }
    }
  }
  for (const id of Object.keys(a.components ?? {}))
    need(byId[id], `components.${id}: unknown (config/components.json)`);
  return errors;
}

/** The env file for the answers. Generated secrets are kept from `current` unless rotated. */
export function render(a, current = {}, { rotate = [], secrets = {}, previous } = {}) {
  const vars = {
    ...a.server,
    domain: a.domain,
    project: a.project,
    repo: a.images.repo,
    tls: a.tls,
  };
  const env = {};
  const generated = [];
  const missing = [];
  const invalid = [];
  const expand = (t) =>
    t.replace(/\{(?:hex:(\d+)|(\w+))\}/g, (_, n, k) =>
      n ? randomBytes(Number(n)).toString('hex') : (vars[k] ?? env[k] ?? ''),
    );
  const owned = new Set();
  const profiles = [];
  for (const c of catalog) {
    const mode = modeOf(a, c);
    for (const k of [...Object.keys(c.install?.env ?? {}), ...(c.keys ?? [])]) owned.add(k);
    const ca = a.components?.[c.id] ?? {};
    for (const f of fields(c, ca)) owned.add(f.key);
    if (mode === 'install' && c.install) {
      if (c.install.profile) profiles.push(c.install.profile);
      // A value generated while this component was installed survives re-runs.
      const keep = !previous || modeOf(previous, c) === 'install';
      for (const [k, t] of Object.entries(c.install.env ?? {})) {
        if (!t.includes('{hex:')) env[k] = expand(t);
        else {
          generated.push(k);
          env[k] = keep && current[k] && !rotate.includes(k) ? current[k] : expand(t);
        }
      }
    }
    if (mode !== 'connect') continue;
    for (const f of fields(c, ca)) {
      if (f.answerOnly) continue;
      const v = f.secret
        ? (secrets[f.key] ?? current[f.key])
        : (ca[f.key] ?? (f.default === undefined ? undefined : expand(f.default)));
      if (v === undefined) missing.push(f.key);
      else if (f.validate && !new RegExp(f.validate).test(v)) invalid.push(f.key);
      else env[f.key] = v;
    }
  }
  env.COMPOSE_PROFILES = profiles.join(',');
  // Keys no component owns (added by hand with `sops edit`) stay as they are.
  for (const [k, v] of Object.entries(current)) if (!owned.has(k)) env[k] = v;
  // compose interpolates `$` in .env, and one line holds one value
  for (const [k, v] of Object.entries(env)) if (/[$\n\r]/.test(v)) invalid.push(k);
  return { env, generated, missing, invalid };
}

const ramOf = (a) =>
  catalog.reduce((sum, c) => sum + (modeOf(a, c) === 'install' ? (c.install?.ramMiB ?? 0) : 0), 0);

/** The plan: profiles and env KEY NAMES added (+), changed (~), removed (-), and RAM. */
export function plan({ a, current, next, generated, missing = [], serverMiB }) {
  const diff = (before, after) => [
    ...Object.keys(after).flatMap((k) =>
      !(k in before) ? [`+ ${k}`] : before[k] !== after[k] ? [`~ ${k}`] : [],
    ),
    ...Object.keys(before)
      .filter((k) => !(k in after))
      .map((k) => `- ${k}`),
  ];
  const set = (s) =>
    Object.fromEntries(
      (s ?? '')
        .split(',')
        .filter(Boolean)
        .map((p) => [p, p]),
    );
  const keys = diff(current, next).map((l) =>
    generated.includes(l.slice(2)) && l[0] !== '-' ? `${l} (generated)` : l,
  );
  const gib = (m) => `${(m / 1024).toFixed(1)} GiB`;
  const ram = ramOf(a);
  const lines = [
    `Plan for ${a.env}: ${a.server.user}@${a.server.host}, https://${a.domain}, ${a.images.repo} ${a.images.version}`,
    `  components: ${catalog
      .filter((c) => c.available !== false)
      .map((c) => `${c.id} ${modeOf(a, c)}`)
      .join(', ')}`,
    `  profiles: ${diff(set(current.COMPOSE_PROFILES), set(next.COMPOSE_PROFILES)).join(', ') || 'no change'}`,
    `  env keys: ${keys.filter((l) => !l.endsWith('COMPOSE_PROFILES')).join(', ') || 'no change'}`,
    ...(missing.length
      ? [`  missing secrets: ${missing.map((k) => `INFRA_${k}`).join(', ')}`]
      : []),
    `  RAM budget (mem_limit): ${gib(ram)}${serverMiB ? ` of ${gib(serverMiB)} on the server` : ', server RAM unknown'}`,
  ];
  if (serverMiB && ram > serverMiB * 0.9) lines.push('  WARNING: that is more than 90 % of it');
  return lines.join('\n');
}

// --- side effects: sops, ssh, dns -------------------------------------------------------------

const sshArgs = () => (process.env.DEPLOY_SSH_CONFIG ? ['-F', process.env.DEPLOY_SSH_CONFIG] : []);
function ssh(dest, command, { input, capture = false, timeout = 10 } = {}) {
  const out = capture ? 'pipe' : 'inherit';
  return spawnSync(
    'ssh',
    [...sshArgs(), '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`, dest, command],
    { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', out, out] },
  );
}

function decrypt(file) {
  if (!existsSync(file)) return {};
  const r = spawnSync(
    'sops',
    ['decrypt', '--input-type', 'dotenv', '--output-type', 'dotenv', file],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (r.status !== 0) die(`cannot decrypt ${file} (age key: SOPS_AGE_KEY_FILE)`);
  return parseDotenv(r.stdout);
}

function encrypt(file, env) {
  const to = process.env.SOPS_AGE_RECIPIENTS; // else the creation rule in .sops.yaml
  const keys = ['--filename-override', file, ...(to ? ['--age', to] : [])];
  const args = [
    ...(to ? ['--config', '/dev/null'] : []), // global flag: before the subcommand
    'encrypt',
    ...keys,
    ...['--input-type', 'dotenv', '--output-type', 'dotenv'],
  ];
  const r = spawnSync('sops', args, {
    // no file: sops reads stdin
    input: toDotenv(env),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (r.status !== 0) die('sops encrypt failed');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, r.stdout);
}

function preflight(interactive) {
  for (const [tool, flag] of [
    ['ssh', '-V'],
    ['sops', '--version'],
    ['age-keygen', '--version'],
  ]) {
    if (spawnSync(tool, [flag], { stdio: 'ignore' }).error) {
      die(`${tool} not found: brew install ${tool === 'ssh' ? 'openssh' : tool.split('-')[0]}`);
    }
  }
  const fallback = join(homedir(), '.config/sops/age/keys.txt'); // sops' path on Linux, not macOS
  if (!process.env.SOPS_AGE_KEY_FILE && existsSync(fallback))
    process.env.SOPS_AGE_KEY_FILE = fallback;
  if (process.env.SOPS_AGE_RECIPIENTS || !read('.sops.yaml').includes(SOPS_PLACEHOLDER)) return;
  if (!interactive)
    die(
      '.sops.yaml has no age public key yet: run `pnpm run infra` once, or set SOPS_AGE_RECIPIENTS',
    );
  const keyFile = process.env.SOPS_AGE_KEY_FILE ?? fallback;
  if (!existsSync(keyFile)) {
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    execFileSync('age-keygen', ['-o', keyFile], { stdio: 'ignore' });
  }
  const pub = execFileSync('age-keygen', ['-y', keyFile], { encoding: 'utf8' }).trim();
  writeFileSync(join(ROOT, '.sops.yaml'), read('.sops.yaml').replace(SOPS_PLACEHOLDER, pub));
  process.env.SOPS_AGE_KEY_FILE = keyFile;
  console.log(`\n  Your age key: ${keyFile} (public ${pub}, now in .sops.yaml).
  BACK IT UP NOW (password manager or offline): without it nobody can decrypt deploy/env/,
  and every secret of this environment is lost. Add export SOPS_AGE_KEY_FILE=${keyFile}
  to your shell profile.\n`);
}

/** Addresses of a host as ssh would reach it (aliases resolved by `ssh -G`). */
async function addresses(host) {
  const g = spawnSync('ssh', [...sshArgs(), '-G', host], { encoding: 'utf8' });
  const name = /^hostname (.+)$/m.exec(g.stdout ?? '')?.[1] ?? host;
  return (await lookup(name, { all: true }).catch(() => [])).map((x) => x.address);
}

async function checkDns(a, env) {
  const server = await addresses(a.server.host);
  const sites = catalog
    .filter((c) => modeOf(a, c) === 'install' && c.install?.site)
    .map((c) => new URL(env[c.install.site]).hostname);
  const wrong = [];
  for (const name of [a.domain, ...sites]) {
    const got = await addresses(name);
    if (!got.some((x) => server.includes(x)))
      wrong.push(`${name} -> ${got.join(' ') || 'nothing'}`);
  }
  if (!wrong.length) return;
  const msg = `DNS does not point at the server (${server.join(' ')}): ${wrong.join('; ')}`;
  if (a.tls === 'internal') console.warn(`  warning: ${msg}`);
  else die(`${msg}. Add A/AAAA records, wait for them to resolve, run again.`);
}

function bootstrap(a, env, interactive) {
  const admin = `${a.server.admin}@${a.server.host}`;
  const deploy = env.DEPLOY_HOST;
  const step = (name) => {
    const sh = a.server.admin === 'root' ? 'sh -s' : 'sudo -n sh -s';
    const vars = `STEP=${name}\nDEPLOY_USER=${q(a.server.user)}\nDEPLOY_PATH=${q(env.DEPLOY_PATH)}\n`;
    const r = ssh(admin, sh, { input: vars + read('deploy/setup/bootstrap.sh') });
    if (r.status !== 0) die(`bootstrap (${name}) failed on ${admin}; fix it and run again`);
  };
  if (ssh(admin, 'true', { capture: true }).status !== 0) {
    if (!interactive) die(`no key login as ${admin}: run ssh-copy-id ${admin} once`);
    console.log(`No key login as ${admin} yet. ssh-copy-id installs your public key; OpenSSH asks
for the password itself (this tool never reads or stores it).`);
    if (spawnSync('ssh-copy-id', [...sshArgs(), admin], { stdio: 'inherit' }).status !== 0) {
      die('ssh-copy-id failed (no key yet? ssh-keygen -t ed25519)');
    }
  }
  console.log(`bootstrap ${admin}`);
  step('base');
  // Password login goes off only once the deploy user's key login works.
  if (ssh(deploy, 'docker info --format "  docker {{.ServerVersion}} as $(id -un)"').status !== 0) {
    die(`no key login as ${deploy} with Docker access; password login left on`);
  }
  step('harden');
  const probe = spawnSync(
    'ssh',
    [...sshArgs(), '-o', 'BatchMode=yes', '-o', 'PubkeyAuthentication=no', deploy, 'true'],
    { encoding: 'utf8' },
  );
  const offered = /Permission denied \(([^)]*)\)/.exec(probe.stderr ?? '')?.[1] ?? '';
  if (/password|keyboard/.test(offered)) die(`${a.server.host} still offers password login`);
}

function serverMiB(env) {
  const r = ssh(env.DEPLOY_HOST, "awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo", {
    capture: true,
    timeout: 5,
  });
  return r.status === 0 ? Number(r.stdout.trim()) : undefined;
}

function verify(a, env, org) {
  const at = (cmd) => ssh(env.DEPLOY_HOST, `cd ${q(env.DEPLOY_PATH)} && ${cmd}`, { capture: true });
  const port = env.HTTPS_PORT ?? '443';
  const ca = env.CADDY_TLS === 'internal' ? '--cacert .caddy-root.crt' : '';
  const checks = [
    [
      'health',
      `curl -fsS -o /dev/null --max-time 10 ${ca} --resolve ${q(`${a.domain}:${port}:127.0.0.1`)} https://${a.domain}:${port}/api/auth/ok`,
    ],
  ];
  for (const c of catalog) {
    const mode = modeOf(a, c);
    const cmd =
      typeof c.verify === 'string' ? (mode === 'skip' ? null : c.verify) : c.verify?.[mode];
    if (cmd) checks.push([c.id, c.id === 'llm' && org ? `${cmd} ${q(org)}` : cmd]);
  }
  let failed = 0;
  for (const [id, cmd] of checks) {
    const r = at(cmd);
    const last = `${r.stdout}${r.stderr}`.trim().split('\n').at(-1)?.slice(0, 160) ?? '';
    const state = r.status === 0 ? 'ok' : r.status === 3 ? 'skipped' : 'FAILED';
    if (state === 'FAILED') failed++;
    console.log(
      `  ${state.padEnd(7)} ${id.padEnd(10)} ${state === 'ok' && id !== 'health' ? '' : last}`,
    );
  }
  if (failed) die(`${failed} check(s) failed`);
}

function vaultPush(a, env, fresh, rotate) {
  if (spawnSync('node', ['scripts/vault.mjs', 'status'], { stdio: 'ignore' }).status !== 0) {
    console.log('  vault: not unlocked (node scripts/vault.mjs unlock), values not saved there');
    return;
  }
  for (const k of fresh) {
    const cmd = rotate.includes(k) ? 'replace' : 'put';
    spawnSync('node', ['scripts/vault.mjs', cmd, `app/${a.env}`, k], {
      input: env[k],
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  }
}

async function ask(a, current, secrets, only) {
  const p = await import('@clack/prompts');
  const ok = (v) => {
    if (!p.isCancel(v)) return v;
    p.cancel('Nothing changed.');
    process.exit(1);
  };
  const check = (re) => (v) =>
    re && !new RegExp(re).test(v ?? '') ? 'does not look right' : undefined;
  const text = async (message, initialValue, re) =>
    ok(await p.text({ message, initialValue, validate: check(re) }));
  p.intro(`Infrastructure for ${a.env}`);
  if (!only) {
    a.server.host = await text('Server: IP, host name or ssh alias', a.server.host, '^[\\w.-]+$');
    a.server.admin = await text('Admin user (root, or passwordless sudo)', a.server.admin);
    a.domain = await text('Domain of the app (its DNS record points at the server)', a.domain);
    a.tls = await text('E-mail for Let\'s Encrypt ("internal": own CA)', a.tls, '@|^internal$');
    a.images.version = await text(`Release of ${a.images.repo}`, a.images.version);
  }
  for (const c of catalog.filter((c) => c.available !== false && c.modes.length > 1)) {
    if (only && c.id !== only) continue;
    a.components[c.id] ??= {};
    const ca = a.components[c.id];
    const options = c.modes.map((m) => ({ value: m, label: LABEL[m] }));
    const initialValue = ca.mode ?? c.modes[0];
    ca.mode = ok(await p.select({ message: `${c.id}: ${c.description}`, options, initialValue }));
    if (ca.mode !== 'connect') continue;
    for (const f of (c.connect ?? []).flatMap((f) => expandField(f, ca))) {
      if (!f.secret) {
        const list = choices(f.key, ca);
        const initial = ca[f.key] ?? f.default?.replace(/\{(\w+)\}/g, (_, k) => ca[k] ?? '');
        ca[f.key] = list
          ? ok(await p.select({ message: f.prompt, options: list.map((value) => ({ value })) }))
          : await text(f.prompt, initial, f.validate);
      } else if (
        secrets[f.key] === undefined &&
        (!current[f.key] || !ok(await p.confirm({ message: `Keep the current ${f.key}?` })))
      ) {
        secrets[f.key] = ok(await p.password({ message: f.prompt, validate: check(f.validate) }));
      }
    }
  }
  return () => p.confirm({ message: 'Apply this plan?' }).then((v) => v === true);
}

async function main() {
  process.chdir(ROOT);
  const argv = process.argv.slice(2).filter((x) => x !== '--');
  const VALUED = ['--answers', '--rotate', '--org'];
  const opt = (n) => argv[argv.indexOf(n) + 1];
  const rotate = argv.flatMap((x, i) => (x === '--rotate' ? [argv[i + 1]] : []));
  const words = argv.filter((x, i) => !x.startsWith('--') && !VALUED.includes(argv[i - 1]));
  const cmd = ['plan', 'add', 'verify'].includes(words[0]) ? words.shift() : 'setup';
  const only = cmd === 'add' ? words.shift() : undefined;
  const dry = cmd === 'plan' || argv.includes('--dry-run');
  const interactive = !argv.includes('--yes') && cmd !== 'verify' && !dry;
  const envName = words[0] ?? 'production';
  const file = argv.includes('--answers')
    ? opt('--answers')
    : `deploy/setup/${envName}.answers.json`;
  if (only && !byId[only]) die(`unknown component ${only} (config/components.json)`);
  if (only && byId[only].available === false) die(`${only} cannot be added yet (docs/TODO.md)`);

  const version = `v${JSON.parse(read('.release-please-manifest.json'))['.']}`;
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  if (!saved && (!interactive || only)) die(`${file} not found: run pnpm run infra first`);
  const a = structuredClone(saved) ?? {
    env: envName,
    project: 'app',
    server: { host: '', admin: 'root', user: 'deploy' },
    domain: '',
    tls: '',
    images: { repo: UPSTREAM, version },
    components: {},
  };
  const envFile = process.env.DEPLOY_ENV_FILE ?? `deploy/env/${a.env}.enc.env`;
  preflight(interactive);
  const current = decrypt(envFile);
  if (cmd === 'verify') return verify(a, current, opt('--org'));

  const secrets = argv.includes('--secrets-stdin') ? parseDotenv(readFileSync(0, 'utf8')) : {};
  for (const [k, v] of Object.entries(process.env))
    if (k.startsWith('INFRA_')) secrets[k.slice(6)] = v;
  const confirm = interactive ? await ask(a, current, secrets, only) : undefined;
  const errors = validateAnswers(a);
  if (errors.length) die(`${file}:\n  ${errors.join('\n  ')}`);
  const out = render(a, current, { rotate, secrets, previous: saved });
  for (const k of rotate) if (!out.generated.includes(k)) die(`--rotate ${k}: not a generated key`);
  if (out.invalid.length) die(`invalid value (format, or contains $): ${out.invalid.join(', ')}`);
  await checkDns(a, out.env);
  console.log(plan({ a, current, next: out.env, ...out, serverMiB: serverMiB(out.env) }));
  if (dry) return;
  if (out.missing.length)
    die(`missing secrets: ${out.missing.map((k) => `INFRA_${k}`).join(', ')}`);
  if (confirm && !(await confirm())) process.exit(1);

  if (interactive) writeFileSync(file, `${JSON.stringify(a, null, 2)}\n`);
  if (toDotenv(current) !== toDotenv(out.env)) encrypt(envFile, out.env);
  bootstrap(a, out.env, interactive);
  const backups = (out.env.COMPOSE_FILE ?? '').includes('compose.backup.yaml');
  if (!backups) console.warn('  warning: no backups configured (docs/backups.md): --skip-backup');
  const deploy = spawnSync(
    'node',
    [
      'scripts/deploy.mjs',
      a.env,
      '--version',
      a.images.version,
      ...(backups ? [] : ['--skip-backup']),
    ],
    { stdio: 'inherit', env: { ...process.env, DEPLOY_ENV_FILE: envFile } },
  );
  if (deploy.status !== 0) die('deploy failed: fix the cause and run the same command again');
  for (const c of catalog.filter((c) => modeOf(a, c) === 'install' && c.install?.after)) {
    const r = ssh(out.env.DEPLOY_HOST, `cd ${q(out.env.DEPLOY_PATH)} && sh -s`, {
      input: read(c.install.after),
    });
    if (r.status !== 0) die(`${c.id}: ${c.install.after} failed`);
  }
  const fresh = out.generated.filter((k) => !current[k] || rotate.includes(k));
  if (interactive && fresh.length && modeOf(a, byId.vault) !== 'skip') {
    vaultPush(a, out.env, fresh, rotate);
  }
  console.log('verify');
  verify(a, out.env, opt('--org'));
  console.log(`\nDone: https://${a.domain}. Commit ${file} and ${envFile} (values are encrypted).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
