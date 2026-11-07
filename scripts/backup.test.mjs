// node --test 'scripts/*.test.mjs'  (part of pnpm check:ts). Argument handling of backup.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, targetTime } from './backup.mjs';

const now = new Date('2026-11-07T12:00:00Z');

test('target time: ISO with offset -> UTC "+00" form; no zone, garbage or future refused', () => {
  assert.equal(targetTime('2026-11-07T10:00:00Z', now), '2026-11-07 10:00:00.000+00');
  assert.equal(targetTime('2026-11-07T11:30:00.5+01:00', now), '2026-11-07 10:30:00.500+00');
  assert.throws(() => targetTime('2026-11-07T10:00:00', now), /time zone/);
  assert.throws(() => targetTime('yesterday', now), /time zone/);
  assert.throws(() => targetTime('2026-13-40T10:00:00Z', now), /invalid/);
  assert.throws(() => targetTime('2026-11-07T12:00:01Z', now), /future/);
});

test('restore goes to a new instance unless both overwrite flags are given', () => {
  assert.deepEqual(parse(['restore', '--', '--target-time', '2026-11-07T10:00:00Z'], now), {
    command: 'restore',
    inPlace: false,
    target: '2026-11-07 10:00:00.000+00',
  });
  assert.equal(parse(['restore'], now).target, undefined);
  assert.throws(() => parse(['restore', '--in-place'], now), /--yes-overwrite-live/);
  assert.throws(() => parse(['restore', '--yes-overwrite-live'], now), /--in-place/);
  assert.equal(parse(['restore', '--in-place', '--yes-overwrite-live'], now).inPlace, true);
});

test('backup:now type', () => {
  assert.deepEqual(parse(['now'], now), { command: 'now', type: 'full' });
  assert.equal(parse(['now', '--type', 'diff'], now).type, 'diff');
  assert.throws(() => parse(['now', '--type', 'weekly'], now), /full\|diff\|incr/);
  assert.throws(() => parse(['nope'], now), /usage/);
});
