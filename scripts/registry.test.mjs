// node --test 'scripts/*.test.mjs'. The wizard deploys the newest release (scripts/registry.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newestRelease } from './registry.mjs';

test('the newest release is the highest vX.Y.Z, numerically, without pre-releases', () => {
  assert.equal(
    newestRelease(['v1.9.0', 'v1.10.0', 'v1.2.3', 'latest', 'sha-abc', 'v2.0.0-rc.1']),
    'v1.10.0',
  );
  assert.equal(newestRelease(['main', 'pr-12']), undefined);
});
