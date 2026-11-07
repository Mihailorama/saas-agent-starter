<!--
Title = the squash commit on main = the changelog line (docs/releases.md). Conventional Commit:
  feat: <what users can now do>      fix: <what was broken for users>      (shown in CHANGELOG.md)
  chore | docs | refactor | test | ci | build | perf | revert: ...        (hidden or no release alone)
  add `!` for a breaking change: feat!: ...
-->

## What and why

Closes #

## Checklist

- [ ] `pnpm check` is green
- [ ] New user-visible behaviour is behind a flag in `config/flags.json` (docs/feature-flags.md), or this PR removes a fully rolled-out flag
- [ ] New events are in `config/events.json`
