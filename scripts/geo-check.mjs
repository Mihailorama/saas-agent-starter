#!/usr/bin/env node
// `pnpm geo:check [--dry-run] [--out <dir>]`: visibility in AI answers (GEO). Asks every buyer
// question in config/geo.json through the `claude` CLI with the configured model, on your Claude
// subscription, and records whether the product is mentioned, its rank among the brands named
// and whether its domains are cited; writes dist/geo/<date>.md (docs/marketing.md).
// Optional and local only: no CI job, no secret. ANTHROPIC_API_KEY is removed from the child
// environment so the CLI never bills an API key; the model is always passed explicitly.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Neutral context: no repo CLAUDE.md, no user settings or MCP servers, so answers are what a
// buyer would get, not shaped by this project.
const SYSTEM = 'You are a helpful assistant answering a buyer who is choosing software.';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Case-sensitive: brand names are proper nouns ("Notion", not "notion").
const find = (text, name) => text.search(new RegExp(`\\b${escapeRe(name)}\\b`));

/** What one answer says about the product: mention, rank among brands named, citations. */
export function analyze(answer, cfg) {
  const names = [cfg.product, ...(cfg.aliases ?? [])];
  const at = Math.min(...names.map((n) => find(answer, n)).filter((i) => i >= 0), Infinity);
  const brands = [
    { name: cfg.product, at },
    ...(cfg.competitors ?? []).map((name) => ({ name, at: find(answer, name) })),
  ]
    .filter((b) => b.at >= 0 && b.at < Infinity)
    .sort((a, b) => a.at - b.at);
  const urls = [...answer.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)].map((m) => m[0]);
  const cited = urls.filter((u) => {
    const host = new URL(u).hostname;
    return cfg.domains.some((d) => host === d || host.endsWith(`.${d}`));
  });
  const rank = brands.findIndex((b) => b.name === cfg.product) + 1;
  return {
    mentioned: at < Infinity,
    rank: rank || null,
    brands: brands.map((b) => b.name),
    cited: [...new Set(cited)],
    excerpt:
      at < Infinity ? answer.slice(Math.max(0, at - 120), at + 200).replace(/\s+/g, ' ') : '',
  };
}

export function claudeArgs(cfg, question) {
  if (!cfg.model) throw new Error('config/geo.json: "model" is required (no default model)');
  const tools = cfg.webSearch
    ? ['--tools', 'WebSearch', '--allowedTools', 'WebSearch']
    : ['--tools', ''];
  return [
    '-p',
    question,
    '--model',
    cfg.model,
    '--output-format',
    'json',
    '--system-prompt',
    SYSTEM,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    ...tools,
  ];
}

export function report(date, cfg, cli, results) {
  const n = results.length;
  const mentioned = results.filter((r) => r.mentioned).length;
  const cited = results.filter((r) => r.cited.length).length;
  const ranks = results.map((r) => r.rank).filter(Boolean);
  const avg = ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1) : '-';
  const seen = {};
  for (const r of results) for (const b of r.brands) seen[b] = (seen[b] ?? 0) + 1;
  const lines = [
    `# GEO check ${date}`,
    '',
    `Model \`${cfg.model}\` via ${cli} (subscription), web search ${cfg.webSearch ? 'on' : 'off'}. Product: ${cfg.product}; domains: ${cfg.domains.join(', ')}.`,
    '',
    `- Mentioned in ${mentioned}/${n} answers; average rank among brands named: ${avg}`,
    `- Own domain cited in ${cited}/${n} answers`,
    `- Brands named (answers): ${
      Object.entries(seen)
        .sort((a, b) => b[1] - a[1])
        .map(([b, c]) => `${b} ${c}`)
        .join(', ') || 'none'
    }`,
    '',
  ];
  for (const r of results) {
    lines.push(
      `## ${r.question}`,
      '',
      `- Mentioned: ${r.mentioned ? `yes, rank ${r.rank} of ${r.brands.length}` : 'no'}`,
      `- Brands named: ${r.brands.join(', ') || 'none'}`,
      `- Cited: ${r.cited.join(', ') || 'no'}`,
      ...(r.excerpt ? [`- Excerpt: "${r.excerpt}"`] : []),
      ...(r.error ? [`- Error: ${r.error}`] : []),
      '',
      '<details><summary>Full answer</summary>',
      '',
      r.answer,
      '',
      '</details>',
      '',
    );
  }
  return lines.join('\n');
}

function main(argv) {
  const cfg = JSON.parse(readFileSync('config/geo.json', 'utf8'));
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'dist/geo';
  const cli = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (argv.includes('--dry-run') || cli.status !== 0) {
    if (cli.status !== 0)
      console.log('claude CLI not found: dry run (install Claude Code and log in)');
    for (const q of cfg.questions) console.log(`claude ${JSON.stringify(claudeArgs(cfg, q))}`);
    return;
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription only: never bill an API key
  delete env.ANTHROPIC_AUTH_TOKEN;
  const cwd = mkdtempSync(join(tmpdir(), 'geo-')); // outside the repo: no project context
  const results = cfg.questions.map((question, i) => {
    console.log(`[${i + 1}/${cfg.questions.length}] ${question}`);
    let answer = '';
    let error;
    try {
      const raw = execFileSync('claude', claudeArgs(cfg, question), {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 600_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1e7,
      });
      const json = JSON.parse(raw);
      answer = json.result ?? '';
      if (json.is_error) error = answer.slice(0, 200);
    } catch (e) {
      error = String(e.message).split('\n')[0].slice(0, 200);
    }
    return { question, answer, error, ...analyze(answer, cfg) };
  });
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(out, { recursive: true });
  const file = join(out, `${date}.md`);
  writeFileSync(file, report(date, cfg, `claude ${cli.stdout.trim()}`, results));
  const hits = results.filter((r) => r.mentioned).length;
  console.log(`geo:check: mentioned in ${hits}/${results.length} answers -> ${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`geo:check: ${e.message}`);
    process.exit(1);
  }
}
