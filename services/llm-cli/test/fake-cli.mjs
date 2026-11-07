#!/usr/bin/env node
// Stands in for claude / codex / gemini / any CLI in tests. FAKE_AS picks the output format,
// FAKE_MODE the outcome (ok | ratelimit | fail | slow | is_error), FAKE_LOG records each run and
// FAKE_STATE (a directory) tracks how many runs overlap.
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const env = process.env;
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const mark = env.FAKE_STATE && join(env.FAKE_STATE, `run-${process.pid}`);
if (mark) {
  mkdirSync(env.FAKE_STATE, { recursive: true });
  writeFileSync(mark, '');
}
const overlap = env.FAKE_STATE ? readdirSync(env.FAKE_STATE).length : 1;
const system = env.GEMINI_SYSTEM_MD
  ? (await import('node:fs')).readFileSync(env.GEMINI_SYSTEM_MD, 'utf8')
  : null;
if (env.FAKE_LOG) {
  const envKeys = Object.keys(env).sort();
  appendFileSync(
    env.FAKE_LOG,
    `${JSON.stringify({ args, stdin, envKeys, sub: env.FAKE_SUB, overlap, system, cwd: process.cwd() })}\n`,
  );
}
const mode = env.FAKE_MODE ?? 'ok';
if (mode === 'slow' || env.FAKE_DELAY_MS)
  await new Promise((r) => setTimeout(r, Number(env.FAKE_DELAY_MS ?? 2000)));
if (mark) rmSync(mark, { force: true });
if (mode === 'ratelimit') {
  process.stderr.write('API Error: 429 rate limit exceeded\n');
  process.exit(1);
}
if (mode === 'fail') {
  process.stderr.write('boom\n');
  process.exit(2);
}
const model = args[args.indexOf('--model') + 1];
const text = `answer from ${env.FAKE_SUB ?? 'fake'}`;
switch (env.FAKE_AS) {
  case 'claude':
    process.stdout.write(
      JSON.stringify(
        mode === 'is_error'
          ? { type: 'result', is_error: true, result: 'Claude AI usage limit reached' }
          : {
              type: 'result',
              is_error: false,
              result: text,
              usage: {
                input_tokens: 10,
                cache_creation_input_tokens: 5,
                cache_read_input_tokens: 2,
                output_tokens: 7,
              },
              modelUsage: { [`${model}-20261101`]: {} },
              total_cost_usd: 0.01,
            },
      ),
    );
    break;
  case 'codex':
    for (const e of [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'thinking' } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 24, cached_input_tokens: 4, output_tokens: 6 },
      },
    ])
      process.stdout.write(`${JSON.stringify(e)}\n`);
    break;
  case 'gemini':
    process.stdout.write(
      JSON.stringify({
        response: text,
        stats: { models: { [model]: { tokens: { prompt: 11, candidates: 3, total: 14 } } } },
      }),
    );
    break;
  default:
    process.stdout.write(`${text}\n`);
}
