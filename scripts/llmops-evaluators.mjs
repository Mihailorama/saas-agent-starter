#!/usr/bin/env node
// `pnpm llmops:evaluators [--apply]`: online LLM-as-a-judge as code (docs/adr/0009-llm-ops.md).
// For every eval in evals/<purpose>/ it defines one judge in the tools, from the same judge
// prompt (prompts/judge/<purpose>.v<N>.md) and judge model the offline eval uses:
//   Langfuse: POST /api/public/v2/evaluators + /api/public/v2/evaluation-rules
//             (LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY)
//   PostHog:  POST /api/projects/:id/evaluations/ (POSTHOG_APP_HOST, POSTHOG_PROJECT_ID,
//             POSTHOG_PERSONAL_API_KEY with scope evaluation:write)
// Without --apply, or without a tool's env, it prints the requests and sends nothing. Existing
// judges (same name) are left alone, so it is safe on every deploy. Both tools run the judge with
// a provider key configured in the tool (Langfuse "LLM Connection", PostHog "provider key").
import { readdirSync, readFileSync } from 'node:fs';

for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(file);
  } catch {}
}
const apply = process.argv.includes('--apply');
const sampling = Number(process.env.LLMOPS_EVAL_SAMPLING ?? '0.1');
const e = process.env;

/** One judge per purpose, from the eval config (same prompt and model as `pnpm eval:real`). */
const judges = readdirSync('evals', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map(({ name: purpose }) => {
    const { gate, defaultTest } = JSON.parse(
      readFileSync(`evals/${purpose}/promptfooconfig.json`, 'utf8'),
    );
    const text = readFileSync(`prompts/${gate.judge.id}.v${gate.judge.version}.md`, 'utf8');
    return {
      purpose,
      name: `${gate.judge.id} v${gate.judge.version}`,
      // The tools return structured scores themselves: drop our "Answer with JSON" line.
      prompt: text
        .split('\n')
        .filter((l) => !l.startsWith('Answer with JSON'))
        .join('\n')
        .trim(),
      model: defaultTest.options.provider.split(':').at(-1),
    };
  });

async function send(label, url, init, live) {
  console.log(`${live ? 'POST' : 'would POST'} ${url}\n${init.body}\n`);
  if (!live) return null;
  const res = await fetch(url, { method: 'POST', ...init });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function langfuse() {
  const { LANGFUSE_HOST: host, LANGFUSE_PUBLIC_KEY: pk, LANGFUSE_SECRET_KEY: sk } = e;
  const ready = Boolean(host && pk && sk);
  if (!ready) console.log('langfuse: LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY not set, dry run only');
  const headers = {
    authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  const base = host ?? 'http://localhost:3200';
  const list = async (path) =>
    ready && apply
      ? (await (await fetch(`${base}${path}?limit=100`, { headers })).json()).data
      : [];
  const evaluators = await list('/api/public/v2/evaluators');
  const rules = await list('/api/public/v2/evaluation-rules');
  for (const j of judges) {
    let evaluator = evaluators.find((x) => x.name === j.name);
    if (evaluator) console.log(`langfuse: evaluator ${j.name} exists`);
    else {
      evaluator = await send(
        'langfuse evaluator',
        `${base}/api/public/v2/evaluators`,
        {
          headers,
          body: JSON.stringify({
            name: j.name,
            description: `LLM-as-a-judge for ${j.purpose} (repo prompts/, ADR 0009)`,
            type: 'llm_as_judge',
            prompt: j.prompt,
            modelConfig: { provider: 'anthropic', model: j.model },
            variableMapping: [
              { variable: 'input', source: 'input' },
              { variable: 'output', source: 'output' },
            ],
            outputDefinition: {
              dataType: 'NUMERIC',
              minValue: 0,
              maxValue: 1,
              scoreValueInstructions: 'Score from 0 (fails the criteria) to 1 (meets all).',
            },
          }),
        },
        ready && apply,
      );
    }
    const ruleName = `${j.name}: sample of LLM generations`;
    if (rules.some((r) => r.name === ruleName)) {
      console.log(`langfuse: rule ${ruleName} exists`);
      continue;
    }
    await send(
      'langfuse rule',
      `${base}/api/public/v2/evaluation-rules`,
      {
        headers,
        body: JSON.stringify({
          name: ruleName,
          enabled: true,
          sampling,
          // The gateway's LLM spans arrive as GENERATION observations (worker/ai.py).
          filter: [
            { type: 'stringOptions', column: 'type', operator: 'any of', value: ['GENERATION'] },
          ],
          evaluatorAssignments: [{ evaluatorId: evaluator?.id ?? '<evaluator id>' }],
        }),
      },
      ready && apply,
    );
  }
}

async function posthog() {
  const host = e.POSTHOG_APP_HOST;
  const ready = Boolean(host && e.POSTHOG_PROJECT_ID && e.POSTHOG_PERSONAL_API_KEY);
  if (!ready) {
    console.log('posthog: POSTHOG_APP_HOST/PROJECT_ID/PERSONAL_API_KEY not set, dry run only');
  }
  const url = `${host ?? 'https://eu.posthog.com'}/api/projects/${e.POSTHOG_PROJECT_ID ?? '<project id>'}/evaluations/`;
  const headers = {
    authorization: `Bearer ${e.POSTHOG_PERSONAL_API_KEY}`,
    'content-type': 'application/json',
  };
  const existing =
    ready && apply ? ((await (await fetch(url, { headers })).json()).results ?? []) : [];
  for (const j of judges) {
    if (existing.some((x) => x.name === j.name)) {
      console.log(`posthog: ${j.name} exists, skipped`);
      continue;
    }
    // ponytail: field values follow the API reference example; check the first --apply in the UI.
    await send(
      'posthog evaluation',
      url,
      {
        headers,
        body: JSON.stringify({
          name: j.name,
          description: `LLM-as-a-judge for ${j.purpose} (repo prompts/, ADR 0009)`,
          enabled: true,
          evaluation_type: 'llm_judge',
          evaluation_config: { prompt: j.prompt },
          output_type: 'boolean',
          conditions: [
            {
              id: j.purpose,
              rollout_percentage: Math.round(sampling * 100),
              properties: [
                { key: 'ai_purpose', value: j.purpose, operator: 'exact', type: 'event' },
              ],
            },
          ],
          model_configuration: { provider: 'anthropic', model: j.model },
        }),
      },
      ready && apply,
    );
  }
}

await langfuse();
await posthog();
