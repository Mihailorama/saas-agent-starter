# Releases and release notes

Every release has user-facing notes, so support can answer "fixed in which release?" and users
see the answer on their own issue. The notes are generated from PR titles; nobody writes a
changelog by hand. Decision record: [ADR 0020](adr/0020-feature-flags-and-releases.md).

## Flow

1. PRs are squash-merged; the PR title becomes the commit on `main`. The `PR title` check
   (`.github/workflows/pr-title.yml`) requires a [Conventional Commit](https://www.conventionalcommits.org/)
   title: `type(optional scope): summary`.
2. On every push to `main`, release-please (`.github/workflows/release-please.yml`) opens or
   updates one release PR, `chore(main): release X.Y.Z`, with `CHANGELOG.md` and `version.txt`.
3. Merging that PR tags `vX.Y.Z` on `main` and publishes a GitHub release with the same notes.
4. The `Released` workflow comments `Released in vX.Y.Z` on every issue closed by a PR in the
   release and labels it `released`. The same run dispatches the workflows that build on `v*`
   tags (CI's release typecheck, SBOMs, and any deploy workflow, see below).

Releasing is a human decision: merge the release PR when you want to ship. Do not create tags or
releases by hand from a feature branch.

## PR titles

| Title                                                       | Changelog section            | Release and version bump                      |
| ----------------------------------------------------------- | ---------------------------- | --------------------------------------------- |
| `feat: export projects as CSV`                              | Features                     | releases; minor                               |
| `fix(api): 404 on renamed projects`                         | Fixes                        | releases; patch                               |
| `feat!: ...` (any type with `!`)                            | its section, marked breaking | releases; minor before 1.0, major after       |
| `perf: ...`, `revert: ...`                                  | Performance, Reverts         | no release on its own; listed in the next one |
| `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `style` | hidden                       | no release on its own; not listed             |

Only `feat`, `fix` and `deps` commits make release-please open a release PR
([its README](https://github.com/googleapis/release-please#release-please-bot-does-not-create-a-release-pr-why));
the first release starts from `0.0.0` (`.release-please-manifest.json`), so the first `feat`
makes it `v0.1.0`.

Write `feat`/`fix` summaries for users: what changed for them, not how ("fix: AI summary no
longer disappears after a correction", not "fix: invalidate query key"). Internal work uses a
hidden type. Put `Closes #<issue>` in the PR body: that link is what the release comment uses.
Dependabot titles are `chore(deps): ...` (`.github/dependabot.yml`).

GitHub squash-merges a PR that has a single commit with that commit's message instead of the PR
title, so the check also validates the commit message of one-commit PRs.

## Release comment on issues

`scripts/released.mjs <tag>` (run by `.github/workflows/released.yml`): takes the commits from
the previous `v*` tag to the new one, finds their merged PRs, and on each issue those PRs closed
posts `Released in vX.Y.Z (via #PR). Release notes: <release URL>` and adds the label
`released` (created on first use). Re-running is safe: an issue that already has the comment for
that tag is skipped. Try it locally without writing:
`GITHUB_TOKEN=$(gh auth token) node scripts/released.mjs <tag> --dry-run`.

Support integration: a support tool that tracks the GitHub issue linked to a user's conversation
(for example the `support` branch's Chatwoot bridge, which posts a note when the linked issue
closes) can key off this comment instead of the close event: an `issue_comment` whose body starts
with `Released in v` means the fix is live in that version, while "closed" only means merged.

## GitHub token limits and repository settings

- Resources created with the workflow's `GITHUB_TOKEN` (release-please's tag and release) do
  not start other workflows, apart from `workflow_dispatch`. That is why `release-please.yml`
  calls `released.yml` directly and dispatches, on the new tag, every workflow that has both a
  `tags:` trigger and `workflow_dispatch` (today `ci.yml` and `sbom.yml`). A deploy workflow that
  builds images on `v*` tags must add `workflow_dispatch:` to its triggers to be started this
  way; no PAT or other secret is needed.
- release-please opens its PR with `GITHUB_TOKEN`, which needs the repository setting
  Settings -> Actions -> General -> "Allow GitHub Actions to create and approve pull requests".
- For the PR-title rule to hold for every merge, set Settings -> General -> Pull Requests to
  allow squash merging only, with the default commit message "Pull request title".
