#!/usr/bin/env node
// Runs the Promptfoo golden sets in evals/<purpose>/ and fails below `gate.minScore`.
// Promptfoo runs as a container (docs/adr/0009-llm-ops.md). No API key is used anywhere:
//   pnpm eval [purpose...]   replays the recorded outputs, rule assertions only (says so).
//   pnpm eval --fake-llm     replay + a fake judge: checks the judge plumbing (`pnpm check`, CI).
//   pnpm eval:real           the product model the eval config names (`<provider>:<model>` of
//                            config/ai-models.json, any kind) produces each output, and the judge
//                            (claude_cli:claude-opus-5-5) grades it through your Claude
//                            subscription; Promptfoo then applies the same assertions. CLI
//                            providers run the logged-in CLI on this machine with the same adapter
//                            as the llm-cli container; other kinds go through the worker's LiteLLM
//                            path (`python -m worker.complete`, keys from .env). Local only, never
//                            in CI.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { adapters, runCli } from '../services/llm-cli/src/cli.ts';

for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(file);
  } catch {}
}
const args = process.argv.slice(2);
const fake = args.includes('--fake-llm');
const real = args.includes('--real');
const purposes = args.filter((a) => !a.startsWith('--'));
const aiModels = JSON.parse(readFileSync('config/ai-models.json', 'utf8'));
const registry = aiModels.contours;
const contour = process.env.AI_CONTOUR || 'eu';
const JUDGE = 'claude_cli:claude-opus-5-5';

console.log(
  real
    ? 'eval: --real: outputs from the configured provider, verdicts from claude_cli:claude-opus-5-5, graded by Promptfoo'
    : fake
      ? 'eval: --fake-llm: recorded outputs + fake judge (plumbing check, no model is evaluated)'
      : 'eval: replaying recorded outputs with rule assertions only.\n' +
        '      The prompt and the LLM judge are NOT evaluated; run `pnpm eval:real` for that.',
);

/** `<provider>:<model>` in an eval must be registered for the purpose, like in the gateway. */
function checkModel(providerId, purpose) {
  const [provider, ...rest] = providerId.split(':');
  const model = rest.join(':');
  const ok = registry[contour]?.some(
    (m) => m.provider === provider && m.model === model && m.purposes.includes(purpose),
  );
  if (!ok) throw new Error(`${providerId} is not registered for ${purpose} in contour ${contour}`);
  return { provider, model, id: providerId };
}

/** One completion from a registered provider: the CLI on this machine, or LiteLLM via the worker. */
async function complete({ provider, model }, system, prompt) {
  const cfg = aiModels.providers[provider];
  if (cfg?.kind === 'cli') {
    // The host's logged-in CLI (your subscription). Without an API key in its environment, so
    // Claude Code cannot silently bill an API account instead.
    const { ANTHROPIC_API_KEY: _, OPENAI_API_KEY: __, GEMINI_API_KEY: ___, ...env } = process.env;
    const res = await runCli({
      bin: cfg.cli,
      adapter: adapters[cfg.cli],
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      env,
      cwd: tmpdir(),
      timeoutMs: 300_000,
    });
    return res.text.trim();
  }
  const out = execFileSync(
    'uv',
    ['run', '--quiet', 'python', '-m', 'worker.complete', '--provider', provider, '--model', model],
    {
      input: JSON.stringify({ system, prompt }),
      encoding: 'utf8',
      cwd: 'services/worker-py',
      maxBuffer: 1e7,
      timeout: 300_000,
    },
  );
  return out.trim();
}

/** The judge's JSON answer -> score in [0, 1] (same contract as the judge prompt). */
function verdict(text) {
  try {
    const doc = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (typeof doc.score === 'number' && doc.score >= 0 && doc.score <= 1) return doc;
  } catch {}
  return { score: 0, reason: `unusable verdict: ${text.slice(0, 80)}` };
}

let failed = false;
const dirs = purposes.length
  ? purposes
  : readdirSync('evals', { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
for (const purpose of dirs) {
  const dir = `evals/${purpose}`;
  const { gate, ...config } = JSON.parse(readFileSync(`${dir}/promptfooconfig.json`, 'utf8'));
  const models = config.providers.map((p) => checkModel(p.id, gate.purpose));
  // The judge is the operator's, through the Claude subscription (owner decision 2026-11-07).
  if (real && config.defaultTest.options.provider !== JUDGE) {
    throw new Error(`${dir}: the judge must be ${JUDGE}`);
  }
  const judgeModel = checkModel(config.defaultTest.options.provider, 'judge');
  const judge = readFileSync(`prompts/${gate.judge.id}.v${gate.judge.version}.md`, 'utf8').trim();
  config.defaultTest.options.rubricPrompt = judge;
  config.providers = ['file://../replay.mjs'];
  mkdirSync(`${dir}/.out`, { recursive: true });
  if (fake) {
    config.defaultTest.options.provider = 'file://../fake-judge.mjs';
  } else {
    config.defaultTest.assert = config.defaultTest.assert.filter((a) => a.type !== 'llm-rubric');
  }
  if (real) {
    // ponytail: sequential CLI calls; fine for a golden set of tens of cases.
    const system = readFileSync(`prompts/${gate.prompt.id}.v${gate.prompt.version}.md`, 'utf8');
    const cases = readFileSync(`${dir}/dataset.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
    for (const c of cases) {
      const output = await complete(models[0], system.trim(), c.vars.input);
      const rendered = judge.replaceAll('{{input}}', c.vars.input).replaceAll('{{output}}', output);
      const v = verdict(await complete(judgeModel, 'You are a strict grader.', rendered));
      c.vars = { ...c.vars, recorded_output: output, judge_score: v.score, judge_reason: v.reason };
    }
    writeFileSync(`${dir}/.out/real.jsonl`, cases.map((c) => JSON.stringify(c)).join('\n'));
    config.tests = 'file://.out/real.jsonl';
    config.defaultTest.assert.push({
      type: 'javascript',
      metric: 'judge',
      value:
        '({ pass: context.vars.judge_score >= 0.5, score: context.vars.judge_score,' +
        ' reason: String(context.vars.judge_reason) })',
    });
  }
  // Written next to the original so relative file:// paths resolve the same way.
  writeFileSync(`${dir}/.effective.json`, JSON.stringify(config, null, 2));
  const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  try {
    execFileSync(
      'docker',
      [
        'compose',
        '--profile',
        'eval',
        'run',
        '--rm',
        '--no-deps',
        '--user',
        uid,
        '-e',
        `PROMPT_ID=${gate.prompt.id}`,
        '-e',
        `PROMPT_VERSION=${gate.prompt.version}`,
        'promptfoo',
        'eval',
        '-c',
        `${dir}/.effective.json`,
        '--no-cache',
        '--no-write',
        '--no-table',
        '-o',
        `${dir}/.out/results.json`,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
  } catch {
    // Promptfoo exits non-zero when any test fails; the gate below decides.
  }
  const results = JSON.parse(readFileSync(`${dir}/.out/results.json`, 'utf8')).results.results;
  const score = results.reduce((s, r) => s + (r.score ?? 0), 0) / Math.max(results.length, 1);
  const passed = results.filter((r) => r.success).length;
  const ok = results.length > 0 && score >= gate.minScore;
  const mode = real
    ? `real: ${models[0].id}, judge ${judgeModel.id}`
    : fake
      ? 'fake-llm'
      : 'replay, rules only';
  console.log(
    `eval ${purpose}: prompt ${gate.prompt.id} v${gate.prompt.version}, ${passed}/${results.length} passed,` +
      ` mean score ${score.toFixed(3)} (gate ${gate.minScore}) -> ${ok ? 'ok' : 'FAIL'} [${mode}]`,
  );
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
