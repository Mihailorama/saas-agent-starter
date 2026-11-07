# Releases and release notes

Every release has user-facing notes, so support can answer "fixed in which release?" and users
see the answer on their own tracker item. The notes are generated from PR titles; nobody writes a
changelog by hand. Decision record: [ADR 0020](adr/0020-feature-flags-and-releases.md).

## Flow

1. PRs are squash-merged; the PR title becomes the commit on `main`. The `PR title` check
   (`.github/workflows/pr-title.yml`) requires a [Conventional Commit](https://www.conventionalcommits.org/)
   title: `type(optional scope): summary`.
2. On every push to `main`, release-please (`.github/workflows/release-please.yml`) opens or
   updates one release PR, `chore(main): release X.Y.Z`, with `CHANGELOG.md` and `version.txt`.
3. Merging that PR tags `vX.Y.Z` on `main` and publishes a GitHub release with the same notes.
4. The `Released` workflow comments `Released in vX.Y.Z` on every tracker item a PR in the
   release refers to (Plane by default, below). The same run dispatches the workflows that build on `v*`
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
hidden type. Name the tracker item in the PR: the Plane identifier (`APP-123`, the project's
identifier and the item's number) in the title or body, or, with `TRACKER=github`, `Closes #<issue>`
in the body. That reference is what the release comment uses.
Dependabot titles are `chore(deps): ...` (`.github/dependabot.yml`).

The repository allows squash merging only, with the PR title as the commit title. The check also
validates the commit message of one-commit PRs, so the rule still holds if a fork or a future
settings change goes back to GitHub's default (commit title for one-commit PRs).

## Release comment on tracker items

`scripts/released.mjs <tag>` (run by `.github/workflows/released.yml`): takes the commits from
the previous `v*` tag to the new one and finds their merged PRs (GitHub API), then comments
`Released in vX.Y.Z (via #PR). Release notes: <release URL>` on every item they refer to,
through the same tracker as the rest of the app (`apps/api/src/tracker.ts`, docs/support.md):

- Plane (`TRACKER=plane`, default): identifiers of the configured project (`APP-123`) in the PR
  title or body, resolved with `GET /workspaces/{slug}/work-items/APP-123/`; unknown ones are
  skipped. The comment is a work item comment. The item's state is never changed: closing it is a
  human's call.
- GitHub (`TRACKER=github`, optional): the issues the PR closed (closing keywords, GraphQL
  `closingIssuesReferences`).

Re-running is safe: an item that already has the comment for that tag is skipped. Try it locally
without writing: `GITHUB_TOKEN=$(gh auth token) PLANE_API_TOKEN=... node scripts/released.mjs <tag> --dry-run`.
In the workflow, set the repository variables `PLANE_API_URL`, `PLANE_WORKSPACE`,
`PLANE_PROJECT_ID` (and `TRACKER=github` to switch) and the secret `PLANE_API_TOKEN`; without
them the step logs "nothing to do".

Support integration: the Chatwoot bridge (docs/support.md, "Return path") keys off this comment
instead of the close event: a new comment starting with `Released in v` on a linked item (Plane
webhook **Work item comments -> Created**, or GitHub **Issue comments**) means the fix is live in
that version, while "closed" only means merged.

## GitHub token limits and repository settings

- Resources created with the workflow's `GITHUB_TOKEN` (release-please's tag and release) do
  not start other workflows, apart from `workflow_dispatch`. That is why `release-please.yml`
  calls `released.yml` directly and dispatches, on the new tag, every workflow that has both a
  `tags:` trigger and `workflow_dispatch` (today `ci.yml`, `sbom.yml` and `release.yml`, which builds
  the images, docs/deploy.md). A new workflow that runs on `v*` tags must add `workflow_dispatch:`
  to its triggers to be started this way; no PAT or other secret is needed.
- release-please opens its PR with `GITHUB_TOKEN`. That needs Settings -> Actions -> General ->
  "Allow GitHub Actions to create and approve pull requests", which is on in this repository
  (set 2026-11-07); a fork or copy of the template must turn it on too. Checks on that PR (CI, PR title) start in an approval-required state, because it was opened
  with `GITHUB_TOKEN`: click "Approve workflows to run" on the release PR before merging it.
- Settings -> General -> Pull Requests: squash merging only, default commit title "Pull request
  title" (set 2026-11-07; merge commits and rebase merging are off). Copies of the template need
  the same settings for the PR-title rule to hold.
