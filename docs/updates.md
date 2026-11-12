# Taking starter updates into your product

Your product is a copy of this repository that lives on. The starter keeps getting fixes,
security updates and new components; this page is how you take them without losing your own
work. Decision in short: **git merge of a starter release tag**, never a rebase, a squash or a
copy of files, so git remembers what you already took and the next update only brings what is
new.

## Once: add the starter as a remote

```sh
git remote add starter https://github.com/Mihailorama/saas-agent-starter.git
git fetch starter --tags
```

If you created your repository with "Use this template" (no shared history), make the first
merge with `--allow-unrelated-histories` and expect every file you changed to conflict once;
after that, merges are ordinary.

## Each update

1. Pick the version. Releases are tags `vX.Y.Z` with notes in the starter's `CHANGELOG.md` and on
   its GitHub releases page; read the **BREAKING** entries first. Until the starter publishes its
   first release, use `starter/main`.
2. Branch and merge:

   ```sh
   git fetch starter --tags
   git switch -c chore/starter-vX.Y.Z
   git merge vX.Y.Z        # or starter/main before the first release
   ```

3. Resolve conflicts with the table below, then:

   ```sh
   pnpm install            # also regenerates the lockfile you took from either side
   pnpm api:types          # web API types from the merged routes
   pnpm db:migrate
   pnpm check
   ```

   The checks tell you what a merge broke: `check:migrations` the migration order,
   `check:events`, `check:flags`, `check:components` and `check:legal` the catalogs, the
   failing `tests/test_prompts.py` the prompt hashes (it prints the lines to add).
4. Open the PR and merge it **with a merge commit**. A squash merge drops the link to the starter's
   history, and the next update conflicts on everything again. The template allows squash only
   (docs/releases.md), so turn on "Allow merge commits" in Settings -> General and use it only
   for these PRs. Title it `chore: starter vX.Y.Z` (or `feat:` if your users get something from it).
5. Release and deploy as usual (docs/releases.md, docs/deploy.md). If you deploy the starter's
   images rather than your own (`IMAGE_REPO`), build yours first: your code is not in them.

## Conflicts you will see

| Files                                                                                                                   | What to do                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`, `apps/site/` pages, posts and texts, `CHANGELOG.md`, `version.txt`, `.release-please-manifest.json`        | Yours. Keep your side; look at the starter's diff for anything you want to copy by hand (a new FAQ answer, a fixed component).                                      |
| `config/plans.json`, `legal.json` (company), `geo.json`, `crm.json`, `tracker.json`, `journeys.json`, `ui-council.json` | Yours, but read the starter's change: a new required field fails a check until you add it.                                                                          |
| `config/events.json`, `flags.json`, `components.json`, `ai-models.json`, `webhook-events.json`, `rewards.json`          | Both. Keep your entries and the starter's new ones; the checks validate the result.                                                                                 |
| `pnpm-lock.yaml`, `apps/web/src/lib/api.gen.ts`, `prompts/lock.json`, `config/legal.lock.json`                          | Generated. Take either side, then regenerate (`pnpm install`, `pnpm api:types`, the lines the failing test or `pnpm check:legal` prints). Never merge them by hand. |
| `packages/db/migrations/`                                                                                               | See below: order matters.                                                                                                                                           |
| `AGENTS.md`                                                                                                             | Both. Keep the starter's rules current and your product's rules in their own section (below).                                                                       |
| `apps/web/src/index.css`, `DESIGN.md`                                                                                   | Yours for tokens and brand; take the starter's new tokens and components.                                                                                           |

## Migrations: the one conflict that can break production

Drizzle's migrator applies only migrations newer than the last one a database recorded (the
`when` in `migrations/meta/_journal.json`). Say you added `0016_invoices` last month and the
starter's release brings its own `0016_audit_index`, made two weeks earlier. Merged naively,
the starter's migration is older than yours, and every database that already ran yours skips it
without an error. `pnpm check:migrations` fails on exactly this (an entry older than the one
before it, a number used twice, a gap in `idx`).

Fix it by moving the starter's new migrations after yours, never the other way round (yours
already ran in your databases):

1. In the journal, keep your entries as they are and put the starter's new entries after them.
2. Give each one the next free number: rename `NNNN_name.sql` and its `meta/NNNN_snapshot.json`,
   set `tag` and `idx` to match, and set `when` to the current time in milliseconds
   (`node -p Date.now()`), increasing for each.
3. In the last snapshot, `prevId` must be the `id` of the snapshot before it.
4. `pnpm db:generate` must now create nothing: if it does, the merged `schema.ts` and the
   migrations disagree, and that is a real conflict to resolve in `schema.ts`.
5. `pnpm check:migrations` and `pnpm db:migrate` on a copy of production data (docs/backups.md,
   the `postgres-restore` copy) before you deploy.

A migration of yours that never reached any database is easier: delete it, merge, then run
`pnpm db:generate` again.

## Keep the next merge small

- Add, don't edit: new files for your resources, pages and workflows (the recipes in AGENTS.md
  already work that way). Every starter file you edit is a file that can conflict.
- Product rules go under a `## Product` section at the end of AGENTS.md, so the starter's
  sections merge cleanly.
- Take updates often. One release at a time is a small merge; a year at once is a project.
- Changes that would help every product built on the starter belong upstream: open an issue or
  a PR in the starter, and take it back with the next update.
