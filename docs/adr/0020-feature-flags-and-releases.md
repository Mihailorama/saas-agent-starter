# 0020. Feature flags in PostHog, release notes from PR titles

Status: accepted (owner decision, 2026-11-07)

## Context

Coding agents ship changes continuously. Two gaps: a change reaches every user at once, so a
bad change is a full incident instead of a small rollout; and nothing records which release
contains which fix, so support cannot answer "fixed in release X". The owner decided that
changes ship gradually behind flags using PostHog's built-in feature flags (no new flag
service), and that every release has user-facing notes.

## Decision

Feature flags ([docs/feature-flags.md](../feature-flags.md)):

- PostHog feature flags in the PostHog project we already use for analytics (ADR 0012). The repo
  keeps the contract: `config/flags.json` (name, description, owner, default, expiry) checked by
  `pnpm check:flags`, `pnpm flags:sync` to create flags through PostHog's API, and one wrapper per
  runtime: `posthog-js` in the web, `posthog-node` (MIT) in the API, and PostHog's documented
  `/flags?v=2` HTTP endpoint through the existing `httpx2` in the Python worker (the `posthog`
  PyPI SDK pulls `distro`, whose license string the gate does not accept yet; see
  docs/feature-flags.md).
- One evaluation order everywhere: `FLAGS_ON`/`FLAGS_OFF` env, then PostHog, then the catalog
  default. Without PostHog (Umami-only, on-prem, RU contour) the code path is the same and flags
  are per deployment.
- Server-side evaluation is remote by default (only the public project key); in the API, local
  evaluation turns on when a project secret key with `feature_flag:read` is set. Remote adds a
  request per check; local adds a secret and a 30 s poll per instance.
- Context: internal user id as the person, organization as the `organization` group, `plan` as a
  group property when present. No personal data.
- In the web, flags come from PostHog only after analytics consent; before that the default.

Release notes ([docs/releases.md](../releases.md)):

- release-please (Apache-2.0, Google) in manifest mode with the `simple` strategy for the whole
  monorepo: one release PR with `CHANGELOG.md`, tag `vX.Y.Z` (no component prefix) on merge.
  Features and Fixes are shown; chores, docs, refactors, tests, CI and build are hidden.
- Conventional Commits come from PR titles: squash-merge titles become the commits, checked by
  `amannn/action-semantic-pull-request` (MIT), including the single-commit case.
- `scripts/released.mjs` comments "Released in vX.Y.Z" on issues closed by the release's PRs and
  labels them `released`; it runs from release-please's workflow because releases made with
  `GITHUB_TOKEN` start no workflows. Tag workflows are started with `workflow_dispatch` for the
  same reason. No new secrets.

## Alternatives

- Own flag table and admin UI: rejected by the owner; a product category of its own (targeting,
  percentage hashing, audit, experiments).
- Unleash, Flagsmith, GrowthBook, OpenFeature + flagd: mature and self-hostable, and the
  replacement if an on-prem or RU client needs percentage rollouts without PostHog (servers:
  Flagsmith BSD-3-Clause, flagd Apache-2.0, Unleash AGPL-3.0, GrowthBook mixed open-core; as
  unmodified infra containers all are allowed by ADR 0005). Not chosen as the default
  because PostHog is already configured and links flags to the same users, funnels and replays.
- OpenFeature SDK in front of PostHog: an extra layer with one provider today; add it if a second
  flag backend becomes real.
- Changesets: per-package versions and changeset files written by hand; suits published npm
  packages, not one product. semantic-release: releases on every merge with no review step and a
  plugin chain; release-please keeps a reviewable release PR.
- Conventional Commits on every commit (commitlint hook): breaks agents' and humans' history for
  little gain when PRs are squash-merged; checking the PR title is enough.
- A PAT or GitHub App token so tags trigger workflows: works, but is a new long-lived secret.

## Consequences

- New code dependency: `posthog-node` (MIT, API); the worker adds none. Actions:
  `googleapis/release-please-action` (Apache-2.0), `amannn/action-semantic-pull-request` (MIT),
  both pinned by SHA.
- Without PostHog there are no percentage or per-organization rollouts, only on/off per
  deployment. Organization targeting in PostHog needs its paid group-analytics add-on.
- Web rollouts reach consenting users only; the API does not depend on consent, so features
  spanning both must tolerate the web showing the old path.
- The repository needs "Allow GitHub Actions to create and approve pull requests" for the release
  PR, and squash-only merging with the PR title as the commit for the title rule to hold.
- Deploy workflows that build on `v*` tags need `workflow_dispatch` to be started by a release.
