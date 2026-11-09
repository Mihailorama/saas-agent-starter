#!/usr/bin/env node
// `prepare` (runs on `pnpm install`): point git at .githooks (the pre-push visual check,
// docs/ui.md). Never in CI, outside a git checkout, or over a hooksPath someone else set.
import { spawnSync } from 'node:child_process';

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });

if (process.env.CI) process.exit(0);
if (git('rev-parse', '--git-dir').status !== 0) process.exit(0); // no git, e.g. a Docker build
const current = git('config', '--get', 'core.hooksPath').stdout.trim();
if (current === '.githooks') process.exit(0);
if (current) {
  console.log(
    `hooks: core.hooksPath is "${current}", left alone; the visual pre-push check is not installed (docs/ui.md)`,
  );
  process.exit(0);
}
git('config', 'core.hooksPath', '.githooks');
