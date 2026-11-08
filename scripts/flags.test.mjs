// node --test 'scripts/*.test.mjs'  (part of pnpm check:ts). Flag catalog checker and sync payload.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFlags } from './check-flags.mjs';
import { newFlag } from './flags.mjs';

const flag = { description: 'New form.', owner: '@example', default: false, expires: '2027-03-31' };
const today = '2027-01-01';

test('catalogued literal flags pass, in TS and Python', () => {
  const r = checkFlags(
    { 'new-form': flag },
    [
      ['a.tsx', 'const on = useFlag(\'new-form\');\nif (await isEnabled("new-form", ctx)) {}'],
      ['b.py', 'if await is_enabled("new-form", user_id=u):\n    pass'],
    ],
    today,
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual([...r.used], ['new-form']);
});

test('unknown and non-literal flag names fail', () => {
  const r = checkFlags(
    { 'new-form': flag },
    [['a.ts', "isEnabled('typo', ctx);\nisEnabled(name, ctx);"]],
    today,
  );
  assert.deepEqual(r.errors, [
    'a.ts:1: flag "typo" is not in config/flags.json',
    'a.ts:2: isEnabled() needs a literal flag name',
  ]);
});

test('definitions, comments and method calls are not flag checks', () => {
  const src = [
    'export async function isEnabled(flag: string) {}',
    'async def is_enabled(flag: str) -> bool:',
    "// isEnabled('nope')",
    'snapshot.isEnabled(flag);',
    'return async function isEnabled(flag, ctx) {',
  ].join('\n');
  assert.deepEqual(checkFlags({}, [['w.ts', src]], today).errors, []);
});

test('bad catalog entries fail', () => {
  const r = checkFlags(
    {
      Bad: { ...flag },
      'no-owner': { ...flag, owner: '' },
      x: { ...flag, default: 'no', expires: '2027-02-30' },
    },
    [],
    today,
  );
  assert.deepEqual(r.errors, [
    'catalog: bad flag name "Bad"',
    'catalog: no-owner lacks owner',
    'catalog: x.default must be true or false',
    'catalog: x.expires must be a date (YYYY-MM-DD)',
  ]);
});

test('expired and unused flags warn but do not fail', () => {
  const r = checkFlags({ old: { ...flag, expires: '2026-12-31' } }, [], today);
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings[0], /flag "old" expired on 2026-12-31 \(owner @example\)/);
  assert.match(r.warnings[1], /never checked in code.*old/);
});

test('flags:sync creates new flags at the catalog default rollout', () => {
  assert.equal(newFlag('a', flag).filters.groups[0].rollout_percentage, 0);
  assert.equal(newFlag('a', { ...flag, default: true }).filters.groups[0].rollout_percentage, 100);
  assert.equal(newFlag('a', flag).key, 'a');
});

test('flags linked to surveys count as used', () => {
  const r = checkFlags({ 'nps-survey': flag }, [], today, ['nps-survey']);
  assert.deepEqual(r.warnings, []);
});
