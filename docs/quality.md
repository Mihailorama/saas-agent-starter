# Quality budgets

`pnpm check` is the definition of done (AGENTS.md). Three things decide what that green means,
so they are checks of their own, `pnpm check:budgets` (`scripts/check-budgets.mjs`, limits in
`config/budgets.json`). The lesson behind them, from running coding agents on real projects: a
rule that exists only as prose ("never weaken a check") gets broken; the same rule as a check
holds.

## Gate configs

`gateFiles` holds a hash of each file that configures a gate: Biome (`biome.json`), TypeScript
(`tsconfig.base.json`), the license gate (`scripts/license-check.mjs`, `deny.toml`), ruff and
pyright (only their tables in `services/worker-py/pyproject.toml`), the Lighthouse budgets
(`apps/*/lighthouserc.cjs`) and the layout guards (`apps/web/e2e/layout.ts`).

Changing one fails the check until the same change records the new hash, which the failure
prints. That does not forbid changing a gate; it makes it a visible line in the diff instead of a
side effect hidden in a larger change. Change a gate only on purpose, say why in the PR, and
never to make a failing check pass. Tightening a gate is welcome.

## Suppressions

`suppressionsMax` caps the lines in code that silence a check: `biome-ignore`, `eslint-disable`,
`@ts-expect-error` and `@ts-ignore`, `# noqa`, `type: ignore`, `pyright: ignore`,
`#[allow(...)]`. Over the cap, the check lists all of them. Fix the code instead; when a
suppression is the right answer (a test that checks bad input on purpose), raise the cap by one in
the same change. When you remove some, lower the cap so it stays tight.

## AGENTS.md size

Agents read AGENTS.md on every task, and the longer it is, the worse its rules are followed.
`agentsMdMaxBytes` caps it. Over the cap, move the detail into the matching doc under `docs/` and
leave a one-line pointer.

## Bug fixes

Not a check, a rule (AGENTS.md "Definition of done"): a fix comes with a test that fails without
it, so the same bug cannot come back unnoticed.
