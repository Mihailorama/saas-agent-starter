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
import { createHash } from 'node:crypto';
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
// What can change a screenshot: the app, the config files it imports, the lockfile and the
// committed env defaults (VITE_*).
const UI_PATHS = [
  'apps/web',
  'config/ai-models.json',
  'config/ai-transparency.json',
  'config/legal.json',
  'config/events.json',
  'config/flags.json',
  'config/journeys.json',
  '.env.example',
  'pnpm-lock.yaml',
];
// What renders the screenshots: a change here makes main's cached shots invalid.
const HARNESS = ['e2e/visual.spec.ts', 'e2e/visual-pages.ts', 'playwright.visual.config.ts'];
const BASE_REF = process.env.VISUAL_BASE ?? 'origin/main';
const REVIEW_MODEL = 'claude-opus-5-5';
const REVIEW_TIMEOUT_MS = 180_000;
const KEEP_CACHED = 5;
// A wildcard may declare at most this many changed screens; more is "everything changed".
const MAX_PER_WILDCARD = 5;

/** Screen ids a `.visual-intent` text declares: one per line, `#` starts a comment, `*` globs. */
export function parseIntent(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
}

/**
 * The intent this branch adds: the `+` lines of `git diff -U0 <merge-base> -- .visual-intent`.
 * What main already has was another change's intent; an id can be declared again by adding it
 * again.
 */
export function addedIntent(diff) {
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  return [...new Set(parseIntent(added.join('\n')))];
}

export function matches(pattern, id) {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${re}$`).test(id);
}

/**
 * Changed screenshots and other failures (layout guards, axe, crashes) from Playwright's JSON and
 * exit status. A run that executed nothing, or failed for a reason no test explains (a web server
 * that never started), is a failure, never a pass.
 */
export function readResults(json, status = 0) {
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
  for (const e of json.errors ?? [])
    failures.push(`run: ${(e.message ?? String(e)).split('\n')[0].slice(0, 200)}`);
  const st = json.stats ?? {};
  if ((st.expected ?? 0) + (st.unexpected ?? 0) + (st.flaky ?? 0) === 0)
    failures.push('run: no test was executed');
  if (status !== 0 && !failures.length && !changes.length)
    failures.push(`run: Playwright exited with status ${status}`);
  return { changes, failures };
}

/**
 * The decision: every changed screen must be declared. A wildcard that matches every known
 * screen, or more than MAX_PER_WILDCARD changed ones, declares nothing: it is rejected.
 */
export function decide(changes, intent, known = []) {
  const changedIds = [...new Set(changes.map((c) => c.id))];
  const allIds = [...new Set([...known, ...changedIds])];
  const hits = (p, ids) => ids.filter((id) => matches(p, id));
  const rejected = intent.filter(
    (p) =>
      p.includes('*') &&
      ((allIds.length > 0 && hits(p, allIds).length === allIds.length) ||
        hits(p, changedIds).length > MAX_PER_WILDCARD),
  );
  const accepted = intent.filter((p) => !rejected.includes(p));
  const matched = Object.fromEntries(accepted.map((p) => [p, hits(p, changedIds)]));
  const declared = changes.filter((c) => accepted.some((p) => matches(p, c.id)));
  const undeclared = changes.filter((c) => !declared.includes(c));
  const unused = accepted.filter((p) => !matched[p].length);
  return {
    ok: undeclared.length === 0 && rejected.length === 0,
    declared,
    undeclared,
    unused,
    rejected,
    matched,
  };
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
  const { declared, undeclared, unused, rejected = [], matched = {} } = decision;
  const declaredNow = Object.entries(matched).filter(([, ids]) => ids.length);
  return [
    `# Visual check against main (${base.slice(0, 12)})`,
    '',
    failures.length || !decision.ok ? '**Result: FAIL**' : '**Result: pass**',
    '',
    ...(declaredNow.length
      ? [
          'Declared intent (apps/web/.visual-intent, lines this branch adds):',
          '',
          ...declaredNow.map(
            ([p, ids]) => `- \`${p}\` -> ${ids.map((i) => `\`${i}\``).join(', ')}`,
          ),
          '',
        ]
      : []),
    ...(rejected.length
      ? [
          `## Rejected intent: a wildcard may not declare every screen or more than ${MAX_PER_WILDCARD} changed ones`,
          '',
          ...rejected.map((p) => `- \`${p}\``),
          '',
          'List the screens you mean to change by id.',
          '',
        ]
      : []),
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

/**
 * Marks main's render as reusable only when it ran clean. A failed render (a screen main lacks,
 * a crash) is still used for this run, but rendered again next time.
 */
export function finishMainRender(cache, status) {
  if (status !== 0) return false;
  writeFileSync(join(cache, '.done'), '');
  return true;
}

/**
 * The pre-push hook may reuse a pass only for the exact same thing: the same merge-base with main
 * and the same committed tree, with nothing uncommitted under the UI paths (`key` is null then).
 * Git opens the connection to the remote before it runs the hook and the remote drops it while a
 * long check runs, so a push can die after the check passed; the retry must not run it again.
 */
export function canReuse(stamp, key) {
  return key !== null && stamp?.trim() === key;
}

/** Environment for the review CLI: the subscription login only, never a key or another backend. */
export function reviewEnv(env) {
  const out = { ...env };
  for (const k of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ])
    delete out[k];
  return out;
}

const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/**
 * A TCP port nothing listens on right now. The visual web server used to take a fixed 5177, so a
 * second project built on the starter on the same machine (or its `pnpm dev`) made the check fail.
 */
export function freePort() {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      "const s = require('node:net').createServer().listen(0, 'localhost', () => { console.log(s.address().port); s.close(); });",
    ],
    { encoding: 'utf8' },
  );
  const port = Number(r.stdout.trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error('visual: found no free port');
  return port;
}

let port;
export function playwright(args, env) {
  // One port per run (VISUAL_PORT wins): main's render and the working tree's never overlap.
  port ??= process.env.VISUAL_PORT ?? String(freePort());
  return spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.visual.config.ts', ...args],
    {
      cwd: web,
      stdio: 'inherit',
      env: { ...process.env, VISUAL_PORT: port, ...env },
    },
  ).status;
}

function hasUiChanges(base) {
  const diff = spawnSync('git', ['diff', '--quiet', base, '--', ...UI_PATHS], { cwd: root }).status;
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...UI_PATHS);
  return diff !== 0 || untracked !== '';
}

/** `<merge-base>:<HEAD tree>`, or null when anything under the UI paths is uncommitted. */
function passKey(base) {
  const dirty = git('status', '--porcelain', '--', ...UI_PATHS);
  return dirty ? null : `${base}:${git('rev-parse', 'HEAD^{tree}')}`;
}

/** Main's screenshots at `base`, rendered from a temporary worktree; cached per sha. */
export function mainScreenshots(base) {
  const pw = execFileSync('pnpm', ['exec', 'playwright', '--version'], {
    cwd: web,
    encoding: 'utf8',
  });
  const harness = createHash('sha256');
  for (const f of HARNESS) harness.update(readFileSync(join(web, f)));
  const key = `${base.slice(0, 12)}-pw${pw.trim().split(' ').at(-1)}-${harness.digest('hex').slice(0, 8)}`;
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
  let status = 1;
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
    status = playwright(['visual.spec.ts', '--update-snapshots=all', '--reporter=dot'], {
      VISUAL_WEB_DIR: join(tree, 'apps/web'),
      VISUAL_SNAPSHOT_DIR: cache,
      VISUAL_OUT: join(dir, 'main-run'),
    });
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root, stdio: 'ignore' });
  }
  if (!existsSync(cache) || !readdirSync(cache).length)
    throw new Error(`visual: no screenshots of main (${base}); see the output above`);
  if (!finishMainRender(cache, status))
    console.log('visual: main rendered with failures; its shots are used now but not cached');
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
  const env = reviewEnv(process.env);
  const verdicts = {};
  for (const c of declared.filter((c) => c.files.actual)) {
    const r = spawnSync('claude', reviewArgs(c, intent), {
      cwd: dir,
      encoding: 'utf8',
      env,
      timeout: REVIEW_TIMEOUT_MS,
    });
    verdicts[`${c.project}/${c.id}`] =
      r.status === 0
        ? r.stdout.trim().replace(/\s+/g, ' ')
        : `review failed (${r.error?.code === 'ETIMEDOUT' ? 'timed out' : 'claude CLI error'})`;
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
    base = git('merge-base', 'HEAD', BASE_REF);
  } catch {
    console.error(
      [
        `visual: no merge-base with ${BASE_REF}. Fetch it: \`git fetch origin main\`;`,
        'in a shallow clone `git fetch --unshallow origin main`; if your remote is not called',
        '`origin`, set VISUAL_BASE=<remote>/main.',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (!hasUiChanges(base)) {
    // The pre-push hook: nothing in the UI changed, so there is nothing to check.
    if (process.argv.includes('--hook')) {
      console.log(`visual: no UI changes against main (${base.slice(0, 12)}); skipped`);
      process.exit(0);
    }
    layoutOnly(1, `no UI changes against main (${base.slice(0, 12)})`);
  }

  const key = passKey(base);
  const stampFile = join(dir, 'passed');
  const stamp = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : null;
  if (process.argv.includes('--hook') && canReuse(stamp, key)) {
    console.log('visual: already passed for this commit against this main; skipped');
    process.exit(0);
  }

  const cache = mainScreenshots(base);
  const out = join(dir, 'run');
  rmSync(out, { recursive: true, force: true });
  const status = playwright([], { VISUAL_SNAPSHOT_DIR: cache, VISUAL_OUT: out });

  const resultsFile = join(out, 'results.json');
  if (!existsSync(resultsFile)) {
    console.error('visual: Playwright wrote no results; see the output above');
    process.exit(1);
  }
  const { changes, failures } = readResults(
    JSON.parse(readFileSync(resultsFile, 'utf8')),
    status ?? 1,
  );
  // Read from the working tree, compared with the merge-base: uncommitted lines count too.
  const inBase =
    spawnSync('git', ['cat-file', '-e', `${base}:${INTENT}`], { cwd: root }).status === 0;
  let intent = [];
  if (inBase) intent = addedIntent(git('diff', '-U0', base, '--', INTENT));
  else if (existsSync(join(root, INTENT)))
    intent = parseIntent(readFileSync(join(root, INTENT), 'utf8'));
  const known = readdirSync(cache, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(cache, d.name)))
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.slice(0, -4));
  const decision = decide(changes, intent, known);
  const verdicts = process.argv.includes('--review') ? review(decision.declared, intent) : {};
  const text = report({ base, decision, failures, verdicts });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), text);
  console.log(`\n${text}\nReport: ${relative(root, join(dir, 'report.md'))}`);
  const passed = !failures.length && decision.ok;
  if (passed && key) writeFileSync(stampFile, key);
  else rmSync(stampFile, { force: true });
  process.exit(passed ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
