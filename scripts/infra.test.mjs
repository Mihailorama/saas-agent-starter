// node --test 'scripts/*.test.mjs' (part of pnpm check:ts). `pnpm run infra` without a server:
// catalog check, answers validation, env rendering, the plan (dry-run) and that no value leaks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkComponents } from './check-components.mjs';
import {
  catalog,
  expandField,
  freshEnvError,
  plan,
  render,
  rotateErrors,
  validateAnswers,
} from './infra.mjs';

const answers = () => ({
  env: 'production',
  project: 'app',
  server: { host: '203.0.113.10', admin: 'root', user: 'deploy' },
  domain: 'app.example.com',
  tls: 'ops@example.com',
  images: { repo: 'ghcr.io/mihailorama/saas-agent-starter', version: 'v1.0.0' },
  components: {
    postgres: { mode: 'install' },
    s3: { mode: 'install' },
    smtp: { mode: 'connect', MAIL_FROM: 'Workspace <no-reply@example.com>' },
    analytics: { mode: 'connect', POSTHOG_KEY: 'phc_example' },
    llm: {
      mode: 'connect',
      AI_CONTOUR: 'eu',
      AI_PROJECT_SUMMARY_PROVIDER: 'anthropic',
      AI_PROJECT_SUMMARY_MODEL: 'claude-haiku-5-5',
    },
    vault: { mode: 'skip' },
  },
});
const secrets = {
  SMTP_URL: 'smtp://local-dev-user:local-dev-pass@smtp.example.com:587',
  ANTHROPIC_API_KEY: 'local-dev-anthropic-key',
};

test('the catalog covers every prod profile and example.env key', () => {
  const profiles = ['db', 's3', 'vault', 'analytics', 'ops', 'pii', 'llm-cli', 'booking'];
  const ok = checkComponents(catalog, profiles, ['DATABASE_URL']);
  assert.deepEqual(ok, []);
  const bad = checkComponents(catalog, [...profiles, 'newthing'], ['DATABASE_URL', 'NEW_KEY']);
  assert.deepEqual(bad.slice(-2), [
    'compose.prod.yaml profile newthing: no component',
    'deploy/env/example.env NEW_KEY: no component',
  ]);
  const broken = [{ id: 'x', tier: 'core', description: 'x', modes: ['install'], install: {} }];
  assert.match(checkComponents(broken, [], []).join(), /install needs ramMiB/);
});

test('answers: valid ones pass, secrets and wrong choices are refused', () => {
  assert.deepEqual(validateAnswers(answers()), []);
  const a = answers();
  a.components.smtp.SMTP_URL = 'smtp://x@y';
  a.components.vault = { mode: 'install' };
  a.components.postgres.mode = 'connect';
  a.components.llm.AI_PROJECT_SUMMARY_MODEL = 'gpt-0';
  a.components.nope = { mode: 'skip' };
  a.components.booking = { mode: 'install' };
  delete a.components.s3;
  a.tls = 'not an email';
  const errors = validateAnswers(a).join('\n');
  for (const re of [
    /smtp\.SMTP_URL: a secret, never in answers \(use INFRA_SMTP_URL\)/,
    /vault: install needs postgres install/,
    /postgres\.TEMPORAL_DB_HOST: missing/,
    /llm\.AI_PROJECT_SUMMARY_MODEL: one of claude-haiku-5-5, claude-sonnet-5-5/,
    /components\.nope: unknown/,
    /booking: not available yet/,
    /components\.s3: install\|connect/,
    /tls: e-mail or internal/,
  ]) {
    assert.match(errors, re);
  }
});

test('render: secrets generated once, kept, rotated on request; derived values follow', () => {
  const first = render(answers(), {}, { secrets });
  const { env } = first;
  assert.deepEqual(first.missing, []);
  assert.equal(env.COMPOSE_PROFILES, 'db,s3');
  assert.equal(env.DEPLOY_HOST, 'deploy@203.0.113.10');
  assert.match(env.BETTER_AUTH_SECRET, /^[0-9a-f]{64}$/);
  assert.match(env.WEBHOOK_ENCRYPTION_KEYS, /^k1:[0-9a-f]{64}$/);
  assert.equal(
    env.MIGRATION_DATABASE_URL,
    `postgres://postgres:${env.POSTGRES_PASSWORD}@postgres:5432/app`,
  );
  assert.equal(env.TEMPORAL_DB_PASSWORD, env.POSTGRES_PASSWORD);
  assert.equal(env.S3_PUBLIC_ENDPOINT, 'https://s3.app.example.com');
  assert.equal(env.POSTHOG_HOST, 'https://eu.i.posthog.com'); // default
  assert.equal(env.ANTHROPIC_API_KEY, secrets.ANTHROPIC_API_KEY); // @apiKey -> provider's key
  assert.ok(first.generated.includes('DATABASE_URL') && !first.generated.includes('S3_REGION'));

  const current = { ...env, SENTRY_DSN: 'https://k@sentry.example.com/1' };
  const again = render(answers(), current, { rotate: ['BETTER_AUTH_SECRET'] });
  assert.equal(again.env.POSTGRES_PASSWORD, env.POSTGRES_PASSWORD); // kept
  assert.equal(again.env.SMTP_URL, secrets.SMTP_URL); // connect secret kept from the env file
  assert.notEqual(again.env.BETTER_AUTH_SECRET, env.BETTER_AUTH_SECRET); // rotated
  assert.equal(again.env.SENTRY_DSN, current.SENTRY_DSN); // not owned by a component: untouched

  const a = answers();
  a.components.analytics = { mode: 'skip' };
  const skipped = render(a, current);
  assert.equal(skipped.env.POSTHOG_KEY, undefined); // skipped component: its keys go
  assert.deepEqual(render(answers(), {}).missing, ['SMTP_URL', 'ANTHROPIC_API_KEY']);
  assert.deepEqual(
    render(answers(), {}, { secrets: { ...secrets, SMTP_URL: 'smtp://a$b@x' } }).invalid,
    ['SMTP_URL'],
  );
});

test('plan (dry run): key names only, no value, exact text', () => {
  const printed = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...m) => printed.push(m.join(' '));
  try {
    const a = answers();
    const current = render(a, {}, { secrets }).env;
    a.components.analytics = { mode: 'install' };
    a.components.vault = { mode: 'install' };
    const out = render(a, { ...current, POSTHOG_KEY: 'phc_old' }, { rotate: ['S3_ACCESS_KEY_ID'] });
    const text = plan({ a, current, next: out.env, ...out, serverMiB: 3900 });
    assert.equal(
      text,
      `Plan for production: deploy@203.0.113.10, https://app.example.com, ghcr.io/mihailorama/saas-agent-starter v1.0.0
  components: core install, postgres install, s3 install, smtp connect, analytics install, llm connect, vault install
  profiles: + analytics, + vault
  env keys: ~ S3_ACCESS_KEY_ID (generated), + UMAMI_PUBLIC_URL, + UMAMI_DB_PASSWORD (generated), + UMAMI_APP_SECRET (generated), + UMAMI_ADMIN_PASSWORD (generated), + ANALYTICS_ORIGINS, + VAULT_PUBLIC_URL, + VAULT_DB_PASSWORD (generated), + VAULT_DATABASE_URL, - POSTHOG_HOST, - POSTHOG_KEY
  RAM budget (mem_limit): 3.5 GiB of 3.8 GiB on the server
  WARNING: that is more than 90 % of it`,
    );
    for (const value of [...out.generated.map((k) => out.env[k]), ...Object.values(secrets)]) {
      assert.ok(!text.includes(value) && !printed.join('\n').includes(value), 'a value leaked');
    }
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(printed, []);
});

test('@apiKey follows the env names of config/ai-models.json', () => {
  const { providers } = JSON.parse(
    readFileSync(new URL('../config/ai-models.json', import.meta.url)),
  );
  const f = { key: '@apiKey', prompt: 'key', secret: true };
  for (const [id, p] of Object.entries(providers)) {
    const keys = expandField(f, { AI_PROJECT_SUMMARY_PROVIDER: id }).map((x) => x.key);
    assert.deepEqual(keys, [p.baseUrlEnv, p.apiKeyEnv].filter(Boolean), id);
  }
});

test("bootstrap keeps every SSH port open: the client's, sshd -T, ListenAddress, ssh.socket", () => {
  const ports = (vars) => {
    const script = readFileSync(new URL('../deploy/setup/bootstrap.sh', import.meta.url), 'utf8');
    const head = Object.entries({ STEP: 'ports', ...vars })
      .map(([k, v]) => `${k}='${v}'`)
      .join('\n');
    return spawnSync('sh', ['-s'], { input: `${head}\n${script}`, encoding: 'utf8' }).stdout.trim();
  };
  const dump = 'port 22\nlistenaddress [::]:2200\nlistenaddress 0.0.0.0:22\npermitrootlogin no';
  const sock = 'Listen=[::]:2022 (Stream)';
  assert.equal(
    ports({ CLIENT_SSH_PORT: '2222', SSHD_DUMP: dump, SOCKET_LISTEN: sock }),
    '22 2022 2200 2222',
  );
  assert.equal(ports({ CLIENT_SSH_PORT: '2222', SSHD_DUMP: '', SOCKET_LISTEN: '' }), '2222');
  assert.equal(ports({ CLIENT_SSH_PORT: '', SSHD_DUMP: '', SOCKET_LISTEN: '' }), ''); // ufw stays off
});

test('a missing env file never mints new live secrets', () => {
  const at = { envExists: false, envFile: 'deploy/env/production.enc.env' };
  assert.equal(freshEnvError({ ...at, savedAnswers: false, serverHasEnv: false }), undefined); // first run
  assert.match(
    freshEnvError({ ...at, savedAnswers: true, serverHasEnv: false }),
    /answers exist.*Restore/s,
  );
  assert.match(
    freshEnvError({ ...at, savedAnswers: false, serverHasEnv: true }),
    /server already runs/,
  );
  assert.equal(
    freshEnvError({ ...at, envExists: true, savedAnswers: true, serverHasEnv: true }),
    undefined,
  );
});

test('--rotate only what the server re-applies', () => {
  assert.deepEqual(rotateErrors(['BETTER_AUTH_SECRET', 'DATABASE_URL', 'VAULT_DB_PASSWORD']), []);
  const errors = rotateErrors([
    'POSTGRES_PASSWORD',
    'UMAMI_ADMIN_PASSWORD',
    'WEBHOOK_ENCRYPTION_KEYS',
  ]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /--rotate POSTGRES_PASSWORD: nothing re-applies it/);
});
