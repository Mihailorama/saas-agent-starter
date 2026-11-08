// node --test 'scripts/*.test.mjs'. Pure parts of visual.mjs: intent matching and the decision.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addedIntent,
  decide,
  matches,
  parseIntent,
  readResults,
  report,
  reviewArgs,
} from './visual.mjs';

test('parseIntent drops comments and blank lines', () => {
  assert.deepEqual(parseIntent('# header\n\npage-sign-in   # new OTP field\n  gallery-*\n'), [
    'page-sign-in',
    'gallery-*',
  ]);
});

test('only intent added on the branch counts; merged entries are spent', () => {
  const base = '# header\npage-sign-in\n';
  assert.deepEqual(addedIntent('# header\npage-sign-in\nscreen-list\n', base), ['screen-list']);
  assert.deepEqual(addedIntent(base, base), []);
  assert.deepEqual(addedIntent('', base), []);
  assert.deepEqual(addedIntent('page-sign-in\n', ''), ['page-sign-in']);
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
});
