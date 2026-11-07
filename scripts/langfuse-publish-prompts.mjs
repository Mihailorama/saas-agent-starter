#!/usr/bin/env node
// Publishes the repo prompts (prompts/<purpose>/<name>.v<N>.md) to Langfuse prompt management
// (Full profile, docs/adr/0009-llm-ops.md). Run on deploy; safe to re-run. Git stays the source
// of truth: each repo version becomes a Langfuse version labeled `v<N>`, created only if that
// label does not exist yet. Env: LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(file);
  } catch {}
}
const { LANGFUSE_HOST: host, LANGFUSE_PUBLIC_KEY: pk, LANGFUSE_SECRET_KEY: sk } = process.env;
if (!host || !pk || !sk) {
  console.error('LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required');
  process.exit(1);
}
const headers = {
  authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}`,
  'content-type': 'application/json',
};
const api = (path, init) =>
  fetch(new URL(`/api/public/v2/prompts${path}`, host), { headers, ...init });

let created = 0;
let existing = 0;
for (const file of readdirSync('prompts', { recursive: true }).sort()) {
  const match = /^(.+)\.v([1-9]\d*)\.md$/.exec(String(file).replaceAll('\\', '/'));
  if (!match) continue;
  const [, name, version] = match;
  const text = readFileSync(`prompts/${file}`, 'utf8').trim();
  const label = `v${version}`;
  const found = await api(`/${encodeURIComponent(name)}?label=${label}`);
  if (found.ok) {
    existing++;
    continue;
  }
  if (found.status !== 404) throw new Error(`GET ${name} ${label}: HTTP ${found.status}`);
  const res = await api('', {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: 'text',
      prompt: text,
      labels: [label],
      config: {
        repoVersion: Number(version),
        sha256: createHash('sha256').update(text).digest('hex'),
      },
      commitMessage: `repo prompts/${file}`,
    }),
  });
  if (!res.ok) throw new Error(`POST ${name} ${label}: HTTP ${res.status} ${await res.text()}`);
  created++;
}
console.log(`langfuse prompts: ${created} created, ${existing} already published`);
