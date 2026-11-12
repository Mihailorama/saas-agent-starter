// node --test 'scripts/*.test.mjs'. Pure parts of check-budgets.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, gateText, hash, SUPPRESSION, suppressions } from './check-budgets.mjs';

const files = {
  'biome.json': '{"x":1}',
  'AGENTS.md': 'rules',
  'a.ts': 'ok\n// biome-ignore lint: why\n',
};
const read = (f) => files[f];
const budgets = (over = {}) => ({
  gateFiles: { 'biome.json': hash('{"x":1}') },
  suppressionsMax: 1,
  agentsMdMaxBytes: 100,
  ...over,
});

test('everything within budget passes', () => {
  assert.deepEqual(check(budgets(), { read, files: Object.keys(files) }), []);
});

test('a changed gate config fails until its new hash is recorded', () => {
  const out = check(budgets({ gateFiles: { 'biome.json': 'old' } }), { read, files: [] });
  assert.match(out.join(), new RegExp(`biome.json changed \\(hash ${hash('{"x":1}')}`));
});

test('more suppressions than the cap fail and are listed', () => {
  const out = check(budgets({ suppressionsMax: 0 }), { read, files: Object.keys(files) });
  assert.match(out.join(), /1 suppressions, the cap is 0[\s\S]*a\.ts:2/);
});

test('an AGENTS.md over the cap fails', () => {
  assert.match(
    check(budgets({ agentsMdMaxBytes: 3 }), { read, files: [] }).join(),
    /AGENTS.md is 5 bytes/,
  );
});

test('every suppression form is recognised, ordinary code is not', () => {
  for (const s of [
    '// biome-ignore lint/x: y',
    '/* eslint-disable */',
    '// @ts-expect-error reason',
    '// @ts-ignore',
    'x = 1  # noqa: E501',
    'y = f()  # type: ignore[arg-type]',
    'z = g()  # pyright: ignore[reportX]',
    '#[allow(clippy::too_many_arguments)]',
  ])
    assert.match(s, SUPPRESSION, s);
  for (const s of ['const ignore = true;', '# allowed values', 'type Ignore = string'])
    assert.doesNotMatch(s, SUPPRESSION, s);
});

test('only code files count, and pyproject gates only on its lint and type tables', () => {
  assert.equal(
    suppressions(['notes.md', 'a.ts'], (f) => (f === 'a.ts' ? '# noqa' : '# noqa')).length,
    1,
  );
  const toml =
    '[project]\nname = "w"\n[tool.ruff]\nline-length = 100\n[tool.uv]\nx = 1\n[tool.pyright]\nstrict = true\n';
  assert.equal(
    gateText('services/worker-py/pyproject.toml', toml),
    '[tool.ruff]\nline-length = 100\n[tool.pyright]\nstrict = true\n',
  );
  assert.equal(gateText('biome.json', toml), toml);
});
