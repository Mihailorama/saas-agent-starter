#!/usr/bin/env node
// `pnpm --filter web visual [-- --review]`: the UI's visual checks, decided without a human
// (docs/ui.md "Visual checks", ADR 0023).
//
// 1. Layout guards and axe (apps/web/e2e/layout.spec.ts) at desktop/mobile x light/dark. Always,
//    also in CI, where this is all that runs: they need no baseline.
// 2. Locally only: screenshots of the working tree compared with screenshots of the merge-base
//    with origin/main, both rendered on this machine (same browser, same fonts). Main's side is
//    built in a temporary git worktree and cached by sha in apps/web/.visual/main/. Nothing is
//    stored in git and nothing goes stale.
// 3. A changed screen passes only if this branch declares it in apps/web/.visual-intent; an
//    undeclared change fails with a report (apps/web/.visual/report.md).
// 4. --review (optional, advisory, never in CI): the `claude` CLI on your subscription looks at
//    each declared diff and writes a short verdict into the report. It never changes the result.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = join(root, 'apps/web');
const dir = join(web, '.visual');
const INTENT = 'apps/web/.visual-intent';
// What can change a screenshot (same list as the UI workflow's paths).
const UI_PATHS = [
  'apps/web',
  'config/ai-models.json',
  'config/ai-transparency.json',
  'pnpm-lock.yaml',
];
const REVIEW_MODEL = 'claude-opus-5-5';
const KEEP_CACHED = 5;

/** Screen ids a `.visual-intent` text declares: one per line, `#` starts a comment, `*` globs. */
export function parseIntent(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
}

/** Only lines this branch added count: what main already has was another change's intent. */
export function addedIntent(current, base) {
  const old = new Set(parseIntent(base));
  return [...new Set(parseIntent(current))].filter((p) => !old.has(p));
}

export function matches(pattern, id) {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${re}$`).test(id);
}

/** Changed screenshots and other failures (layout guards, axe, crashes) from Playwright's JSON. */
export function readResults(json) {
  const changes = [];
  const failures = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const last = t.results.at(-1);
        if (!last || t.status !== 'unexpected') continue;
        const shots = {};
        for (const a of last.attachments ?? []) {
          const m = a.name.match(/^(.+)-(expected|actual|diff)\.png$/);
          if (!m || !a.path) continue;
          shots[m[1]] ??= {};
          shots[m[1]][m[2]] = a.path;
        }
        for (const [id, files] of Object.entries(shots))
          changes.push({ project: t.projectName, id, files, isNew: !files.expected });
        // A failure that is not a screenshot mismatch (layout, axe, timeout) blocks on its own.
        const other = (last.errors ?? []).filter(
          (e) => !/toHaveScreenshot|snapshot doesn't exist/.test(e.message ?? ''),
        );
        if (other.length || !Object.keys(shots).length)
          failures.push(`${t.projectName} › ${spec.title}`);
      }
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of json.suites ?? []) walk(s);
  return { changes, failures };
}

/** The decision: every changed screen must be declared. */
export function decide(changes, intent) {
  const declared = changes.filter((c) => intent.some((p) => matches(p, c.id)));
  const undeclared = changes.filter((c) => !declared.includes(c));
  const unused = intent.filter((p) => !changes.some((c) => matches(p, c.id)));
  return { ok: undeclared.length === 0, declared, undeclared, unused };
}

export function report({ base, decision, failures, verdicts = {} }) {
  const rel = (p) => (p ? relative(root, p) : '-');
  const line = (c) => {
    const v = verdicts[`${c.project}/${c.id}`];
    return [
      `- \`${c.id}\` (${c.project})${c.isNew ? ', new screen' : ''}: actual ${rel(c.files.actual)}, expected ${rel(c.files.expected)}, diff ${rel(c.files.diff)}`,
      ...(v ? [`  - AI review (advisory): ${v}`] : []),
    ];
  };
  const { declared, undeclared, unused } = decision;
  return [
    `# Visual check against main (${base.slice(0, 12)})`,
    '',
    failures.length || undeclared.length ? '**Result: FAIL**' : '**Result: pass**',
    '',
    ...(failures.length
      ? [
          '## Failed checks (layout guards, axe or the run itself)',
          '',
          ...failures.map((f) => `- ${f}`),
          '',
        ]
      : []),
    ...(undeclared.length
      ? [
          '## Changed screens not declared in apps/web/.visual-intent',
          '',
          ...undeclared.flatMap(line),
          '',
          'Intended? Add the ids to apps/web/.visual-intent. Not intended? Fix the code.',
          '',
        ]
      : []),
    ...(declared.length ? ['## Declared changes', '', ...declared.flatMap(line), ''] : []),
    ...(unused.length
      ? ['## Declared but unchanged (fine, or a typo)', '', ...unused.map((p) => `- \`${p}\``), '']
      : []),
    ...(!failures.length && !undeclared.length && !declared.length
      ? ['No visual changes.', '']
      : []),
  ].join('\n');
}

export function reviewArgs(change, intent) {
  const prompt = [
    'You check a UI screenshot change for regressions. The developer declared that this screen is',
    `meant to change (declared ids: ${intent.join(', ')}). Screen: ${change.id}, viewport and theme: ${change.project}.`,
    `Before (main): ${change.files.expected ?? 'none, new screen'}`,
    `After: ${change.files.actual}`,
    `Difference (changed pixels in red): ${change.files.diff ?? 'none'}`,
    'Read the images. Does the After screen show a regression: overlapping elements, clipped or',
    'cut-off text, unreadable contrast, broken alignment or missing content? Answer in at most two',
    'sentences and start with OK or REGRESSION.',
  ].join('\n');
  return [
    '-p',
    prompt,
    '--model',
    REVIEW_MODEL,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--tools',
    'Read',
    '--allowedTools',
    'Read',
    '--add-dir',
    dir,
  ];
}

const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function playwright(args, env) {
  return spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.visual.config.ts', ...args],
    {
      cwd: web,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    },
  ).status;
}

function hasUiChanges(base) {
  const diff = spawnSync('git', ['diff', '--quiet', base, '--', ...UI_PATHS], { cwd: root }).status;
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...UI_PATHS);
  return diff !== 0 || untracked !== '';
}

/** Main's screenshots at `base`, rendered from a temporary worktree; cached per sha. */
function mainScreenshots(base) {
  const pw = execFileSync('pnpm', ['exec', 'playwright', '--version'], {
    cwd: web,
    encoding: 'utf8',
  });
  const key = `${base.slice(0, 12)}-pw${pw.trim().split(' ').at(-1)}`;
  const cache = join(dir, 'main', key);
  if (existsSync(join(cache, '.done'))) {
    console.log(`visual: main's screenshots from cache (${relative(root, cache)})`);
    return cache;
  }
  const tree = join(dir, 'main-worktree');
  spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root, stdio: 'ignore' });
  rmSync(tree, { recursive: true, force: true });
  git('worktree', 'prune');
  rmSync(cache, { recursive: true, force: true });
  console.log(`visual: rendering main (${base.slice(0, 12)}) in a temporary worktree`);
  try {
    git('worktree', 'add', '--detach', tree, base);
    execFileSync(
      'pnpm',
      ['install', '--frozen-lockfile', '--prefer-offline', '--filter', 'web...'],
      {
        cwd: tree,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    // The working tree's spec renders main's app, so both sides take the same screenshots.
    // Screens main does not have fail here and show up as new screens later.
    playwright(['visual.spec.ts', '--update-snapshots=all', '--reporter=dot'], {
      VISUAL_WEB_DIR: join(tree, 'apps/web'),
      VISUAL_SNAPSHOT_DIR: cache,
      VISUAL_OUT: join(dir, 'main-run'),
    });
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root, stdio: 'ignore' });
  }
  if (!existsSync(cache) || !readdirSync(cache).length)
    throw new Error(`visual: no screenshots of main (${base}); see the output above`);
  writeFileSync(join(cache, '.done'), '');
  const old = readdirSync(join(dir, 'main'))
    .map((n) => join(dir, 'main', n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(KEEP_CACHED);
  for (const o of old) rmSync(o, { recursive: true, force: true });
  return cache;
}

function review(declared, intent) {
  const has = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!has) {
    console.log('visual: --review skipped, no `claude` CLI on PATH');
    return {};
  }
  // Subscription only: never bill an API key.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const verdicts = {};
  for (const c of declared.filter((c) => c.files.actual)) {
    const r = spawnSync('claude', reviewArgs(c, intent), { cwd: dir, encoding: 'utf8', env });
    verdicts[`${c.project}/${c.id}`] =
      r.status === 0 ? r.stdout.trim().replace(/\s+/g, ' ') : 'review failed (claude CLI error)';
  }
  return verdicts;
}

function main() {
  const layoutOnly = (code, why) => {
    console.log(`visual: ${why}; layout guards only`);
    const status = playwright(['layout.spec.ts'], {});
    process.exit(status ?? code);
  };
  if (process.env.CI) layoutOnly(1, 'CI compares no pixels (docs/ui.md)');

  let base;
  try {
    base = git('merge-base', 'HEAD', 'origin/main');
  } catch {
    console.error('visual: no merge-base with origin/main; run `git fetch origin main`');
    process.exit(1);
  }
  if (!hasUiChanges(base)) layoutOnly(1, `no UI changes against main (${base.slice(0, 12)})`);

  const cache = mainScreenshots(base);
  const out = join(dir, 'run');
  rmSync(out, { recursive: true, force: true });
  playwright([], { VISUAL_SNAPSHOT_DIR: cache, VISUAL_OUT: out });

  const resultsFile = join(out, 'results.json');
  if (!existsSync(resultsFile)) {
    console.error('visual: Playwright wrote no results; see the output above');
    process.exit(1);
  }
  const { changes, failures } = readResults(JSON.parse(readFileSync(resultsFile, 'utf8')));
  const read = (rev) => {
    try {
      return rev ? git('show', `${rev}:${INTENT}`) : readFileSync(join(root, INTENT), 'utf8');
    } catch {
      return '';
    }
  };
  const intent = addedIntent(read(), read(base));
  const decision = decide(changes, intent);
  const verdicts = process.argv.includes('--review') ? review(decision.declared, intent) : {};
  const text = report({ base, decision, failures, verdicts });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), text);
  console.log(`\n${text}\nReport: ${relative(root, join(dir, 'report.md'))}`);
  process.exit(failures.length || !decision.ok ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
