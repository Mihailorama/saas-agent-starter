import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { adapters, CliError, command, type Message, runCli } from '../src/cli.ts';
import { Busy, type Subscription, Vendor } from '../src/pool.ts';
import { type Config, createApp, load } from '../src/server.ts';

const FAKE = new URL('./fake-cli.mjs', import.meta.url).pathname;
const MESSAGES: Message[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Summarize: Apollo' },
];
const TOKEN = 'local-dev-llm-cli-token-0123456789abcdef';

async function dir() {
  return mkdtemp(join(tmpdir(), 'llm-cli-test-'));
}
const lines = async (file: string) =>
  (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** A subscription whose env is given directly (the server reads it from secret files). */
async function sub(
  name: string,
  env: Record<string, string>,
  concurrency = 1,
): Promise<Subscription> {
  return {
    name,
    concurrency,
    home: await dir(),
    env: { PATH: process.env.PATH ?? '', FAKE_SUB: name, ...env },
  };
}

async function run(as: string, extra: Record<string, string> = {}) {
  const log = join(await dir(), 'log.jsonl');
  const s = await sub('s1', { FAKE_AS: as, FAKE_LOG: log, ...extra });
  const result = await runCli({
    bin: FAKE,
    adapter: adapters[as] ?? command([FAKE, '--model', '{model}', '-p', '{prompt}']),
    model: 'model-x',
    messages: MESSAGES,
    env: s.env,
    cwd: s.home,
    timeoutMs: 10_000,
  });
  const [call] = await lines(log);
  return { result, call };
}

describe('CLI adapters (fake binary)', () => {
  it('claude: -p, explicit model, no tools, JSON with usage incl. cache tokens', async () => {
    const { result, call } = await run('claude');
    assert.deepEqual(call.args.slice(0, 7), [
      '-p',
      '--model',
      'model-x',
      '--output-format',
      'json',
      '--tools',
      '',
    ]);
    assert.ok(call.args.includes('--no-session-persistence'));
    assert.equal(call.args[call.args.indexOf('--system-prompt') + 1], 'Be brief.');
    assert.equal(call.stdin, 'Summarize: Apollo');
    assert.deepEqual(result, {
      text: 'answer from s1',
      model: 'model-x-20261101',
      inputTokens: 17,
      outputTokens: 7,
    });
  });

  it('claude: is_error with a usage-limit text is a rate limit', async () => {
    await assert.rejects(
      run('claude', { FAKE_MODE: 'is_error' }),
      (e: CliError) => e.kind === 'rate_limited',
    );
  });

  it('codex: exec --json from stdin, read-only, instructions lead the prompt', async () => {
    const { result, call } = await run('codex');
    assert.deepEqual(call.args, [
      'exec',
      '--model',
      'model-x',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '-',
    ]);
    assert.equal(call.stdin, '<instructions>\nBe brief.\n</instructions>\n\nSummarize: Apollo');
    assert.deepEqual(result, {
      text: 'answer from s1',
      model: null,
      inputTokens: 24,
      outputTokens: 6,
    });
  });

  it('gemini: JSON output, system prompt from GEMINI_SYSTEM_MD', async () => {
    const { result, call } = await run('gemini');
    assert.deepEqual(call.args, ['--model', 'model-x', '--output-format', 'json', '-p', ' ']);
    assert.equal(call.system, 'Be brief.');
    assert.deepEqual(result, {
      text: 'answer from s1',
      model: 'model-x',
      inputTokens: 11,
      outputTokens: 3,
    });
  });

  it('command: argv template for any other CLI, plain text', async () => {
    const { result, call } = await run('other');
    assert.deepEqual(call.args, ['--model', 'model-x', '-p', 'Be brief.\n\nSummarize: Apollo']);
    assert.equal(call.stdin, '');
    assert.equal(result.text, 'answer from s1');
  });

  it('runs with only the subscription env, in a scratch dir, and classifies failures', async () => {
    process.env.LLM_CLI_TOKEN = TOKEN;
    const { call } = await run('claude');
    assert.ok(!call.envKeys.includes('LLM_CLI_TOKEN'));
    assert.match(call.cwd, /run-/);
    await assert.rejects(
      run('claude', { FAKE_MODE: 'ratelimit' }),
      (e: CliError) => e.kind === 'rate_limited',
    );
    await assert.rejects(
      run('claude', { FAKE_MODE: 'fail' }),
      (e: CliError) => e.kind === 'failed',
    );
    const s = await sub('s1', { FAKE_AS: 'claude', FAKE_MODE: 'slow', FAKE_DELAY_MS: '3000' });
    const slow = runCli({
      bin: FAKE,
      adapter: adapters.claude!,
      model: 'm',
      messages: MESSAGES,
      env: s.env,
      cwd: s.home,
      timeoutMs: 200,
    });
    await assert.rejects(slow, (e: CliError) => e.kind === 'timeout');
  });
});

describe('subscription pool', () => {
  const limits = { maxQueue: 10, queueTimeoutMs: 5_000, cooldownMs: 60_000 };
  const subs = (n: number, concurrency = 1) =>
    Array.from({ length: n }, (_, i) => ({ name: `s${i + 1}`, concurrency, env: {}, home: '' }));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('never runs more than the concurrency limit per subscription, queues the rest', async () => {
    const v = new Vendor(subs(1, 2), limits);
    let running = 0;
    let peak = 0;
    const job = () =>
      v.run(async () => {
        peak = Math.max(peak, ++running);
        await sleep(30);
        running--;
        return 'ok';
      });
    assert.deepEqual(await Promise.all(Array.from({ length: 6 }, job)), Array(6).fill('ok'));
    assert.equal(peak, 2);
  });

  it('round-robins across subscriptions', async () => {
    const v = new Vendor(subs(3), limits);
    const used: string[] = [];
    for (let i = 0; i < 6; i++) await v.run(async (s) => used.push(s.name));
    assert.deepEqual(used, ['s1', 's2', 's3', 's1', 's2', 's3']);
  });

  it('moves a rate-limited request to the next subscription and cools the first down', async () => {
    let now = 0;
    const v = new Vendor(subs(2), limits, () => now);
    const used: string[] = [];
    const result = await v.run(async (s) => {
      used.push(s.name);
      if (s.name === 's1') throw new CliError('429', 'rate_limited');
      return s.name;
    });
    assert.equal(result, 's2');
    assert.deepEqual(used, ['s1', 's2']);
    used.length = 0;
    await v.run(async (s) => used.push(s.name));
    await v.run(async (s) => used.push(s.name));
    assert.deepEqual(used, ['s2', 's2']); // s1 still cooling down
    now = 61_000;
    await v.run(async (s) => used.push(s.name));
    assert.equal(used.at(-1), 's1');
  });

  it('refuses with Busy when every subscription is rate-limited or the queue is full', async () => {
    const limited = new Vendor(subs(2), limits);
    await assert.rejects(
      limited.run(async () => {
        throw new CliError('429', 'rate_limited');
      }),
      (e: Busy) => e instanceof Busy && e.retryAfterSeconds === 60,
    );
    const full = new Vendor(subs(1), { ...limits, maxQueue: 1 });
    const hold = full.run(() => sleep(100));
    const queued = full.run(async () => 'queued');
    await assert.rejects(
      full.run(async () => 'x'),
      Busy,
    );
    await hold;
    assert.equal(await queued, 'queued');
    const slow = new Vendor(subs(1), { ...limits, queueTimeoutMs: 20 });
    const holding = slow.run(() => sleep(100));
    await assert.rejects(
      slow.run(async () => 'x'),
      /timed out/,
    );
    await holding;
  });
});

describe('HTTP shim', () => {
  async function server(mode: Record<string, string>[]) {
    const secrets = await dir();
    const log = join(secrets, 'log.jsonl');
    const subscriptions = [];
    for (const [i, extra] of mode.entries()) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({
        FAKE_AS: 'claude',
        FAKE_LOG: log,
        FAKE_SUB: `claude-${i + 1}`,
        ...extra,
      })) {
        env[k] = join(secrets, `${i}-${k}`);
        await writeFile(env[k]!, v);
      }
      await writeFile(join(secrets, `${i}-auth.json`), '{"token":"local-dev"}');
      subscriptions.push({
        name: `claude-${i + 1}`,
        env,
        files: { '.claude/.credentials.json': join(secrets, `${i}-auth.json`) },
      });
    }
    const config: Config = { clis: { claude: { bin: FAKE, subscriptions } } };
    const app = createApp(await load(config), { token: TOKEN, timeoutMs: 10_000 });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, token = TOKEN) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { app, post, log };
  }
  const request = { model: 'claude-haiku-5-5', messages: MESSAGES, max_tokens: 64 };

  it('answers in the OpenAI chat format with usage; checks token, route and body', async () => {
    const { app, post, log } = await server([{}]);
    try {
      const res = await post('/claude/v1/chat/completions', request);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, 'chat.completion');
      assert.equal(body.choices[0].message.content, 'answer from claude-1');
      assert.equal(body.model, 'claude-haiku-5-5-20261101');
      assert.deepEqual(body.usage, { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24 });
      const [call] = await lines(log);
      assert.equal(call.args[2], 'claude-haiku-5-5');
      assert.ok(call.envKeys.includes('HOME') && !call.envKeys.includes('LLM_CLI_TOKEN'));
      assert.equal((await post('/claude/v1/chat/completions', request, 'wrong')).status, 401);
      assert.equal((await post('/nope/v1/chat/completions', request)).status, 404);
      assert.equal(
        (await post('/claude/v1/chat/completions', { model: '--help', messages: MESSAGES })).status,
        400,
      );
      assert.equal(
        (await post('/claude/v1/chat/completions', { model: 'm', messages: [] })).status,
        400,
      );
    } finally {
      app.close();
    }
  });

  it('falls over to the next subscription, then answers 429 when all are rate-limited', async () => {
    const { app, post } = await server([{ FAKE_MODE: 'ratelimit' }, {}]);
    try {
      const ok = await post('/claude/v1/chat/completions', request);
      assert.equal((await ok.json()).choices[0].message.content, 'answer from claude-2');
    } finally {
      app.close();
    }
    const all = await server([{ FAKE_MODE: 'ratelimit' }, { FAKE_MODE: 'ratelimit' }]);
    try {
      const res = await all.post('/claude/v1/chat/completions', request);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '60');
      assert.equal((await res.json()).error.type, 'rate_limit_error');
    } finally {
      all.app.close();
    }
  });
});
