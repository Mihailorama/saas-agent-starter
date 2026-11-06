#!/usr/bin/env node
// `pnpm eval [purpose...] [--fake-llm]`: runs the Promptfoo golden sets in evals/<purpose>/
// (Promptfoo runs as a container, see docs/adr/0009-llm-ops.md) and fails below `gate.minScore`.
//   ANTHROPIC_API_KEY set: real model + LLM judge (costs money).
//   no key:              replays recorded outputs, rule assertions only (says so).
//   --fake-llm:          replay + a fake judge; checks the judge plumbing (`pnpm check`).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(file);
  } catch {}
}
const args = process.argv.slice(2);
const fake = args.includes('--fake-llm');
const live = !fake && Boolean(process.env.ANTHROPIC_API_KEY);
const purposes = args.filter((a) => !a.startsWith('--'));
const registry = JSON.parse(readFileSync('config/ai-models.json', 'utf8')).contours;
const contour = process.env.AI_CONTOUR || 'eu';

if (!live) {
  console.log(
    fake
      ? 'eval: --fake-llm: recorded outputs + fake judge (plumbing check, no model is evaluated)'
      : 'eval: no ANTHROPIC_API_KEY: replaying recorded outputs with rule assertions only.\n' +
          '      The prompt and the LLM judge are NOT evaluated. Set the key for a real run.',
  );
}

/** Model ids in an eval must be registered for the purpose, like in the gateway. */
function checkModel(providerId, purpose) {
  const [, , model] = providerId.split(':'); // anthropic:messages:<model>
  const ok = registry[contour]?.some((m) => m.model === model && m.purposes.includes(purpose));
  if (!ok) throw new Error(`${providerId} is not registered for ${purpose} in contour ${contour}`);
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
  for (const p of config.providers) checkModel(p.id, gate.purpose);
  checkModel(config.defaultTest.options.provider, 'judge');
  const judge = readFileSync(`prompts/${gate.judge.id}.v${gate.judge.version}.md`, 'utf8');
  config.defaultTest.options.rubricPrompt = judge.trim();
  if (!live) config.providers = ['file://../replay.mjs'];
  if (fake) config.defaultTest.options.provider = 'file://../fake-judge.mjs';
  else if (!live) {
    config.defaultTest.assert = config.defaultTest.assert.filter((a) => a.type !== 'llm-rubric');
  }
  mkdirSync(`${dir}/.out`, { recursive: true });
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
  console.log(
    `eval ${purpose}: prompt ${gate.prompt.id} v${gate.prompt.version}, ${passed}/${results.length} passed,` +
      ` mean score ${score.toFixed(3)} (gate ${gate.minScore}) -> ${ok ? 'ok' : 'FAIL'}` +
      (live ? '' : fake ? ' [fake-llm]' : ' [replay, rules only]'),
  );
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
