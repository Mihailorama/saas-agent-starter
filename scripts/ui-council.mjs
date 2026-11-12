#!/usr/bin/env node
// `pnpm ui:council [-- --members codex] [-- --reset]`: one scoring round of the UI council
// (docs/ui.md "UI council"). A coding agent climbs the score: run a round, fix what the members
// found, run again, until every member rates every category at or above the target.
//
// 1. Screenshots of the working tree (e2e/visual.spec.ts) and of the merge-base with main (the
//    cache scripts/visual.mjs keeps), plus any reference products a developer dropped into
//    apps/web/.visual/references/<product>/*.png. Nothing is committed (no media in git).
// 2. The images are copied under neutral labels in a shuffled order, so a member cannot tell
//    which one is "after", and no member is ever told the target score.
// 3. Each member (config/ui-council.json) scores every product per category on its own CLI
//    subscription, read-only, with an explicit model, and lists findings for this branch.
// 4. Every round is appended to apps/web/.visual/council/history.json; report.md shows the
//    climb round by round for the PR description.
//
// Exit: 0 the whole council passed this round, 2 the members asked for passed (stage the
// expensive ones in next), 1 not yet.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mainScreenshots, matches, playwright, reviewEnv } from './visual.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const visual = join(root, 'apps/web/.visual');
const dir = join(visual, 'council');
const refs = join(visual, 'references');
const BRANCH = 'this branch';
const TIMEOUT_MS = 20 * 60_000;

/** Screenshots under `base/<project>/<id>.png` that the config selects: [{project, id, path}]. */
export function pickShots(base, config) {
  if (!existsSync(base)) return [];
  return config.projects.flatMap((project) => {
    const d = join(base, project);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.slice(0, -4))
      .filter((id) => config.screens.some((p) => matches(p, id)))
      .sort()
      .map((id) => ({ project, id, path: join(d, `${id}.png`) }));
  });
}

/** Reference products: every folder of apps/web/.visual/references with PNGs in it. */
export function referenceShots(base) {
  if (!existsSync(base)) return {};
  const out = {};
  for (const d of readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const files = readdirSync(join(base, d.name))
      .filter((f) => f.endsWith('.png'))
      .sort();
    if (files.length)
      out[d.name] = files.map((f) => ({
        project: 'reference',
        id: f.slice(0, -4),
        path: join(base, d.name, f),
      }));
  }
  return out;
}

/** Neutral labels in a shuffled order: { label: product }. `random` is injectable for tests. */
export function blind(products, random = Math.random) {
  const names = [...products];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return Object.fromEntries(names.map((n, i) => [`product-${i + 1}`, n]));
}

export function prompt({ labels, images, categories, ours }) {
  return [
    'You are one of several independent UI design reviewers. Each product below is a set of',
    'screenshots of a web app (desktop and mobile, light and dark). Look at every image.',
    '',
    ...images.map(
      (im, i) => `Image ${i + 1}: ${im.label}, ${im.project}, screen "${im.id}": ${im.file}`,
    ),
    '',
    `Score each product (${Object.keys(labels).join(', ')}) from 1 to 10 with one decimal in each`,
    `category: ${categories.join('; ')}.`,
    'Compare the products with each other and with the best software you know. Be strict: 10 means',
    'a top product designer would change nothing; 7 is a decent but unremarkable app.',
    `Then list up to 10 findings for ${ours}, most important first: the screen id, what is wrong`,
    'and the concrete change that fixes it (a token, a spacing step, a component, a label).',
    '',
    'Answer with JSON only, no prose and no code fence:',
    '{"scores": {"<product>": {"<category>": <number>}}, "findings": [{"screen": "", "issue": "", "fix": ""}]}',
  ].join('\n');
}

/** The JSON object in a member's answer, mapped back from labels to product names. */
export function parseAnswer(text, labels, categories) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in the answer');
  const json = JSON.parse(text.slice(start, end + 1));
  const scores = {};
  for (const [label, product] of Object.entries(labels)) {
    const s = json.scores?.[label];
    if (!s) throw new Error(`no scores for ${label}`);
    scores[product] = Object.fromEntries(
      categories.map((c) => {
        const n = Number(s[c]);
        if (!Number.isFinite(n) || n < 1 || n > 10)
          throw new Error(`bad score for ${label} / ${c}`);
        return [c, n];
      }),
    );
  }
  const findings = (Array.isArray(json.findings) ? json.findings : []).slice(0, 10);
  return { scores, findings };
}

const mean = (o) => {
  const v = Object.values(o);
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;
};

/** Does one member's verdict pass: every category >= target, and no reference rated higher. */
export function memberPasses(scores, target) {
  const ours = scores[BRANCH];
  if (!ours || Object.values(ours).some((n) => n < target)) return false;
  return Object.entries(scores)
    .filter(([p]) => p !== BRANCH && p !== 'main')
    .every(([, s]) => mean(ours) >= mean(s));
}

export function report({ history, config }) {
  const rounds = [...new Set(history.map((h) => h.round))];
  const last = rounds.at(-1);
  const latest = history.filter((h) => h.round === last);
  const products = [...new Set(latest.flatMap((h) => (h.scores ? Object.keys(h.scores) : [])))];
  const row = (h) => {
    if (h.error) return `| ${h.round} | ${h.member} | error: ${h.error} |`;
    const o = h.scores[BRANCH];
    const others = products
      .filter((p) => p !== BRANCH)
      .map((p) => `${p} ${h.scores[p] ? mean(h.scores[p]) : '-'}`);
    return `| ${h.round} | ${h.member} | ${mean(o)} | ${Math.min(...Object.values(o))} | ${others.join(', ') || '-'} | ${h.pass ? 'yes' : 'no'} |`;
  };
  return [
    `# UI council, round ${last}`,
    '',
    `Target: every member rates every category at least ${config.target}, and this branch at least`,
    'as high as every reference product. Reviewers are not told the target.',
    '',
    '## Rounds',
    '',
    '| Round | Member | This branch (mean) | Lowest category | Others (mean) | Pass |',
    '| --- | --- | --- | --- | --- | --- |',
    ...history.map(row),
    '',
    `## Round ${last} by category (this branch)`,
    '',
    `| Category | ${latest.map((h) => h.member).join(' | ')} |`,
    `| --- | ${latest.map(() => '---').join(' | ')} |`,
    ...config.categories.map(
      (c) => `| ${c} | ${latest.map((h) => (h.scores ? h.scores[BRANCH][c] : '-')).join(' | ')} |`,
    ),
    '',
    `## Round ${last} findings`,
    '',
    ...latest.flatMap((h) => [
      `### ${h.member}`,
      '',
      ...(h.findings?.length
        ? h.findings.map((f) => `- \`${f.screen}\`: ${f.issue} Fix: ${f.fix}`)
        : ['- none']),
      '',
    ]),
  ].join('\n');
}

/** argv for one member's CLI: read-only, explicit model, subscription login only. */
export function memberCommand(member, text, images, workDir) {
  if (!member.model) throw new Error(`member ${member.name}: model is required`);
  if (member.cli === 'claude')
    return {
      cmd: 'claude',
      args: [
        '-p',
        text,
        '--model',
        member.model,
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--tools',
        'Read',
        '--allowedTools',
        'Read',
        '--add-dir',
        workDir,
      ],
      env: reviewEnv(process.env),
    };
  if (member.cli === 'codex') {
    const env = { ...process.env };
    for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY']) delete env[k];
    return {
      cmd: 'codex',
      args: [
        'exec',
        '-m',
        member.model,
        ...(member.effort ? ['-c', `model_reasoning_effort="${member.effort}"`] : []),
        '-s',
        'read-only',
        '--skip-git-repo-check',
        '-C',
        workDir,
        ...images.flatMap((im) => ['-i', im.file]),
        '--',
        text,
      ],
      env,
    };
  }
  throw new Error(`member ${member.name}: unknown cli "${member.cli}" (claude or codex)`);
}

function main() {
  const argv = process.argv.slice(2);
  const config = JSON.parse(readFileSync(join(root, 'config/ui-council.json'), 'utf8'));
  const only = argv.includes('--members') ? argv[argv.indexOf('--members') + 1].split(',') : null;
  const members = config.members.filter((m) => !only || only.includes(m.name));
  if (!members.length) throw new Error(`no members match ${only}`);
  mkdirSync(dir, { recursive: true });
  const histFile = join(dir, 'history.json');
  if (argv.includes('--reset')) rmSync(histFile, { force: true });
  const history = existsSync(histFile) ? JSON.parse(readFileSync(histFile, 'utf8')) : [];

  const base = execFileSync(
    'git',
    ['merge-base', 'HEAD', process.env.VISUAL_BASE ?? 'origin/main'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  ).trim();
  const main = mainScreenshots(base);
  const current = join(dir, 'current');
  rmSync(current, { recursive: true, force: true });
  playwright(
    [
      'visual.spec.ts',
      '--update-snapshots=all',
      '--reporter=dot',
      ...config.projects.flatMap((p) => ['--project', p]),
    ],
    { VISUAL_SNAPSHOT_DIR: current, VISUAL_OUT: join(dir, 'run') },
  );
  const shots = {
    [BRANCH]: pickShots(current, config),
    main: pickShots(main, config),
    ...referenceShots(refs),
  };
  if (!shots[BRANCH].length)
    throw new Error('ui-council: no screenshots of the working tree; see the output above');

  const labels = blind(Object.keys(shots));
  const ours = Object.keys(labels).find((l) => labels[l] === BRANCH);
  const input = join(dir, 'input');
  rmSync(input, { recursive: true, force: true });
  const images = Object.entries(labels).flatMap(([label, product]) =>
    shots[product].map((s) => {
      const file = join(input, label, `${s.project}-${s.id}.png`);
      mkdirSync(join(input, label), { recursive: true });
      copyFileSync(s.path, file);
      return { label, project: s.project, id: s.id, file };
    }),
  );
  const text = prompt({ labels, images, categories: config.categories, ours });

  const round = (history.at(-1)?.round ?? 0) + 1;
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  for (const m of members) {
    console.log(
      `ui-council: round ${round}, ${m.name} (${m.model}) is looking at ${images.length} screenshots`,
    );
    const { cmd, args, env } = memberCommand(m, text, images, input);
    const r = spawnSync(cmd, args, {
      cwd: input,
      encoding: 'utf8',
      env,
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = { round, at: new Date().toISOString(), sha, member: m.name, model: m.model };
    try {
      if (r.status !== 0)
        throw new Error(r.error?.code === 'ETIMEDOUT' ? 'timed out' : `${cmd} exited ${r.status}`);
      Object.assign(entry, parseAnswer(r.stdout, labels, config.categories));
      entry.pass = memberPasses(entry.scores, config.target);
    } catch (e) {
      entry.error = e.message;
      entry.pass = false;
    }
    history.push(entry);
  }
  writeFileSync(histFile, `${JSON.stringify(history, null, 2)}\n`);
  const out = report({ history, config });
  writeFileSync(join(dir, 'report.md'), out);
  console.log(`\n${out}\nReport: ${relative(root, join(dir, 'report.md'))}`);

  const thisRound = history.filter((h) => h.round === round);
  const passed = thisRound.every((h) => h.pass);
  const whole = config.members.every((m) => thisRound.some((h) => h.member === m.name));
  process.exit(passed ? (whole ? 0 : 2) : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
