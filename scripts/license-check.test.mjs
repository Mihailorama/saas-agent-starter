// node --test 'scripts/*.test.mjs'  (part of pnpm check:ts; needs the worker venv for uv)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALIASES, verdicts } from './license-check.mjs';

const check = (licenses) => Object.fromEntries(verdicts(licenses));
const all = (licenses, want) =>
  assert.deepEqual(check(licenses), Object.fromEntries(licenses.map((l) => [l, want])));

test('every alias maps to an allowed license', () => {
  all(Object.keys(ALIASES), true);
  all([' MIT License ', 'Apache License, Version 2.0'], true);
});

test('SPDX expressions: OR needs one branch, AND every part', () => {
  all(
    [
      'MIT',
      'mit', // the library normalizes case
      '(MPL-2.0 OR Apache-2.0)',
      'MIT OR GPL-3.0-only',
      'Apache-2.0 AND CNRI-Python', // regex
      'BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0', // numpy
      'Apache-2.0 AND (MIT OR GPL-3.0-only)',
    ],
    true,
  );
  all(['MIT AND GPL-3.0-only', 'MIT AND (GPL-2.0-only OR LGPL-3.0-only)', 'GPL-2.0+'], false);
});

test('fails closed on unknown, ambiguous, malformed and disallowed strings', () => {
  all(
    [
      'BSD', // which BSD?
      'Apache', // not the classifier
      'UNKNOWN',
      '',
      'MIT-ish',
      'MIT  License', // not an exact alias
      'mit license',
      'MIT OR',
      'MIT AND',
      '(MIT',
      'Other/Proprietary License',
      'LicenseRef-custom',
      'Apache-2.0 WITH LLVM-exception', // exceptions are reviewed in deny.toml only
      'CC-BY-3.0',
      'MPL-1.1',
      'LGPL-2.1-or-later',
      'AGPL-3.0-only',
      'SSPL-1.0',
      'BUSL-1.1',
      'PSF-2.0 AND GPL-2.0-only',
    ],
    false,
  );
});
