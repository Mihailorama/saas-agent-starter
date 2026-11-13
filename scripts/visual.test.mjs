// node --test 'scripts/*.test.mjs'. Pure parts of visual.mjs: intent matching and the decision.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addedIntent,
  canReuse,
  decide,
  finishMainRender,
  freePort,
  matches,
  parseIntent,
  readResults,
  report,
  reviewArgs,
  reviewEnv,
} from './visual.mjs';

test('parseIntent drops comments and blank lines', () => {
  assert.deepEqual(parseIntent('# header\n\npage-sign-in   # new OTP field\n  gallery-*\n'), [
    'page-sign-in',
    'gallery-*',
  ]);
});

test('only lines the branch adds count, and an id main has can be declared again', () => {
  const diff = [
    'diff --git a/apps/web/.visual-intent b/apps/web/.visual-intent',
    '--- a/apps/web/.visual-intent',
    '+++ b/apps/web/.visual-intent',
    '@@ -6,2 +6,3 @@',
    '-page-sign-in   # the OTP change, merged earlier',
    '-screen-list',
    '+page-sign-in   # again, for this change',
    '+screen-form',
    '+# a comment',
  ].join('\n');
  assert.deepEqual(addedIntent(diff), ['page-sign-in', 'screen-form']);
  // Nothing added (only removals, or no diff): nothing declared.
  assert.deepEqual(addedIntent('--- a/x\n+++ b/x\n@@ -1 +0,0 @@\n-screen-list'), []);
  assert.deepEqual(addedIntent(''), []);
});

test('matches is exact unless a * says otherwise', () => {
  assert.ok(matches('page-sign-in', 'page-sign-in'));
  assert.ok(!matches('page-sign', 'page-sign-in'));
  assert.ok(matches('gallery-*', 'gallery-buttons'));
  assert.ok(!matches('gallery-*', 'screen-list'));
  assert.ok(matches('*', 'anything'));
  // Regex characters in ids are literal.
  assert.ok(!matches('page.sign', 'page-sign'));
});

const change = (id, project = 'desktop-light') => ({
  project,
  id,
  files: { actual: `/x/${id}-actual.png`, expected: `/x/${id}-expected.png` },
  isNew: false,
});

test('decide: an undeclared change fails, a declared one passes', () => {
  const changes = [
    change('page-sign-in'),
    change('page-sign-in', 'mobile-dark'),
    change('screen-list'),
  ];
  const d = decide(changes, ['page-sign-in', 'gallery-*']);
  assert.equal(d.ok, false);
  assert.deepEqual(
    d.undeclared.map((c) => c.id),
    ['screen-list'],
  );
  assert.equal(d.declared.length, 2);
  assert.deepEqual(d.unused, ['gallery-*']);
  assert.equal(decide(changes, ['page-*', 'screen-list']).ok, true);
  assert.equal(decide([], []).ok, true);
});

test('decide: a wildcard that declares everything is rejected', () => {
  const known = ['page-sign-in', 'screen-list', 'gallery-buttons', 'gallery-forms'];
  const changes = [change('page-sign-in'), change('screen-list')];
  for (const p of ['*', '*-*']) {
    const d = decide(changes, [p], known);
    assert.equal(d.ok, false, p);
    assert.deepEqual(d.rejected, [p]);
    assert.equal(d.declared.length, 0);
  }
  // More than five changed screens through one wildcard is "everything" too.
  const many = Array.from({ length: 6 }, (_, i) => change(`gallery-s${i}`));
  assert.deepEqual(decide(many, ['gallery-*'], known).rejected, ['gallery-*']);
  // A narrow wildcard is fine, and the report shows what it matched.
  const d = decide([change('gallery-buttons')], ['gallery-*', 'page-sign-in'], known);
  assert.equal(d.ok, true);
  assert.deepEqual(d.matched, { 'gallery-*': ['gallery-buttons'], 'page-sign-in': [] });
  assert.match(
    report({ base: 'abc', decision: d, failures: [] }),
    /^# [^\n]*\n\n\*\*Result: pass\*\*\n\nDeclared intent[^\n]*\n\n- `gallery-\*` -> `gallery-buttons`/,
  );
});

test('readResults separates screenshot changes from other failures', () => {
  const json = {
    suites: [
      {
        specs: [
          {
            title: 'screenshot page-sign-in',
            tests: [
              {
                projectName: 'mobile-light',
                status: 'unexpected',
                results: [
                  {
                    errors: [
                      {
                        message:
                          'Error: expect(page).toHaveScreenshot(expected) failed\n\n  1200 pixels are different.',
                      },
                    ],
                    attachments: [
                      { name: 'page-sign-in-expected.png', path: '/r/e.png' },
                      { name: 'page-sign-in-actual.png', path: '/r/a.png' },
                      { name: 'page-sign-in-diff.png', path: '/r/d.png' },
                      { name: 'trace', path: '/r/trace.zip' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        suites: [
          {
            specs: [
              {
                title: 'screenshot gallery',
                tests: [
                  {
                    projectName: 'desktop-dark',
                    status: 'unexpected',
                    results: [
                      {
                        errors: [{ message: "A snapshot doesn't exist at /c/gallery-new.png" }],
                        attachments: [{ name: 'gallery-new-actual.png', path: '/r/n.png' }],
                      },
                    ],
                  },
                ],
              },
              {
                title: 'layout /dev/ui',
                tests: [
                  {
                    projectName: 'mobile-dark',
                    status: 'unexpected',
                    results: [{ errors: [{ message: 'layout: /dev/ui' }], attachments: [] }],
                  },
                ],
              },
              {
                title: 'layout /sign-in',
                tests: [{ projectName: 'mobile-dark', status: 'expected', results: [{}] }],
              },
            ],
          },
        ],
      },
    ],
    stats: { expected: 1, unexpected: 3, flaky: 0, skipped: 0 },
  };
  const { changes, failures } = readResults(json);
  assert.deepEqual(changes, [
    {
      project: 'mobile-light',
      id: 'page-sign-in',
      files: { expected: '/r/e.png', actual: '/r/a.png', diff: '/r/d.png' },
      isNew: false,
    },
    { project: 'desktop-dark', id: 'gallery-new', files: { actual: '/r/n.png' }, isNew: true },
  ]);
  assert.deepEqual(failures, ['mobile-dark › layout /dev/ui']);
});

test('readResults: a run that executed nothing never passes', () => {
  // The web server did not start: one global error, no test ran, non-zero exit.
  const crashed = {
    suites: [],
    errors: [{ message: 'Error: Timed out waiting 60000ms from config.webServer.\n  at ...' }],
    stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
  };
  assert.deepEqual(readResults(crashed, 1).failures, [
    'run: Error: Timed out waiting 60000ms from config.webServer.',
    'run: no test was executed',
  ]);
  // Every test skipped, exit 0: still nothing was checked.
  assert.deepEqual(readResults({ suites: [], stats: { skipped: 4 } }, 0).failures, [
    'run: no test was executed',
  ]);
  // Non-zero exit that no test or screenshot explains.
  assert.deepEqual(readResults({ suites: [], stats: { expected: 3 } }, 1).failures, [
    'run: Playwright exited with status 1',
  ]);
  assert.deepEqual(readResults({ suites: [], stats: { expected: 3 } }, 0).failures, []);
});

test('main is cached only after a clean render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visual-test-'));
  assert.equal(finishMainRender(dir, 1), false);
  assert.equal(existsSync(join(dir, '.done')), false);
  assert.equal(finishMainRender(dir, null), false);
  assert.equal(existsSync(join(dir, '.done')), false);
  assert.equal(finishMainRender(dir, 0), true);
  assert.equal(existsSync(join(dir, '.done')), true);
});

test('report names every undeclared screen and the verdicts', () => {
  const d = decide([change('screen-list'), change('page-sign-in')], ['page-sign-in']);
  const text = report({
    base: 'abcdef1234567890',
    decision: d,
    failures: [],
    verdicts: { 'desktop-light/page-sign-in': 'OK: the new field fits.' },
  });
  assert.match(text, /Result: FAIL/);
  assert.match(text, /not declared[\s\S]*`screen-list`/);
  assert.match(text, /AI review \(advisory\): OK: the new field fits\./);
  assert.match(
    report({ base: 'abc', decision: decide([], []), failures: [] }),
    /No visual changes/,
  );
});

test('the AI review always names its model and runs read-only', () => {
  const args = reviewArgs(change('page-sign-in'), ['page-sign-in']);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read');
  const env = reviewEnv({
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'x',
    ANTHROPIC_AUTH_TOKEN: 'x',
    ANTHROPIC_BASE_URL: 'x',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
  });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('the hook reuses a pass only for the same main and the same clean commit', () => {
  assert.equal(canReuse('abc:tree1\n', 'abc:tree1'), true);
  assert.equal(canReuse('abc:tree1', 'abc:tree2'), false);
  assert.equal(canReuse('abc:tree1', 'def:tree1'), false);
  assert.equal(canReuse('abc:tree1', null), false);
  assert.equal(canReuse(null, 'abc:tree1'), false);
});

test('freePort returns a port that can be bound right away', async () => {
  const port = freePort();
  const server = createServer();
  await new Promise((ok, fail) => server.once('error', fail).listen(port, 'localhost', ok));
  server.close();
});
