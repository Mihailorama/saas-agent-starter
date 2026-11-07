#!/usr/bin/env node
// node scripts/released.mjs <tag> [--dry-run]   (docs/releases.md; run by .github/workflows/released.yml)
// For every PR merged between the previous v* tag and <tag>, comments "Released in <tag>" on the
// tracker items that PR refers to: Plane (TRACKER=plane, default) work items named by identifier
// (`PROJ-123`) in the PR title or body; GitHub (TRACKER=github) issues the PR closed ("Closes #12").
// Never changes an item's state. Idempotent: an item that already has the comment for this tag is
// skipped. Env: GITHUB_TOKEN (reads the PRs), GITHUB_REPOSITORY (owner/name; defaults to the origin
// remote), and the tracker's variables (apps/api/src/tracker.ts). No tracker credentials = nothing.
import { execFileSync } from 'node:child_process';
import { Octokit, trackerFromEnv } from '../apps/api/src/tracker.ts';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const releasedComment = (tag, pr, repo) =>
  `Released in ${tag} (via #${pr}). Release notes: https://github.com/${repo}/releases/tag/${tag}`;

/** Commits in the release: previous v* tag (exclusive) to `tag`, or all history for the first. */
export function releaseCommits(tag) {
  let prev;
  try {
    prev = git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`);
  } catch {} // first release
  const range = prev ? `${prev}..${tag}` : tag;
  return { prev, shas: git('log', '--format=%H', range).split('\n').filter(Boolean) };
}

async function main(tag, dryRun) {
  const repo =
    process.env.GITHUB_REPOSITORY ??
    git('remote', 'get-url', 'origin').match(/github\.com[:/](.+?)(\.git)?$/)?.[1];
  const [owner, name] = repo.split('/');
  const tracker = trackerFromEnv({ GITHUB_REPO: repo, ...process.env });
  if (!tracker) {
    console.log(`${tag}: no ${process.env.TRACKER || 'plane'} tracker credentials, nothing to do`);
    return;
  }
  const { prev, shas } = releaseCommits(tag);
  console.log(`${tag}: ${shas.length} commits since ${prev ?? 'the first commit'} in ${repo}`);

  const gh = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const prs = new Map(); // number -> PR
  for (const sha of shas) {
    const { data } = await gh.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo: name,
      commit_sha: sha,
    });
    for (const pr of data) if (pr.merged_at) prs.set(pr.number, pr);
  }
  const items = new Map(); // tracker ref -> PR that shipped it
  for (const pr of prs.values()) {
    for (const ref of await tracker.referencedBy(pr))
      if (!items.has(ref)) items.set(ref, pr.number);
  }
  console.log(`  ${prs.size} merged PRs, ${items.size} ${tracker.name} items`);
  for (const [ref, pr] of items) {
    const body = releasedComment(tag, pr, repo);
    if ((await tracker.comments(ref)).some((c) => c.startsWith(`Released in ${tag} `))) {
      console.log(`  ${ref}: already commented`);
    } else if (dryRun) {
      console.log(`  PLAN ${ref}: comment "${body}"`);
    } else {
      await tracker.comment(ref, body);
      console.log(`  ${ref}: commented`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const tag = args.find((a) => !a.startsWith('--'));
  if (!tag || !process.env.GITHUB_TOKEN) {
    console.error('usage: GITHUB_TOKEN=... released.mjs <tag> [--dry-run]');
    process.exit(2);
  }
  await main(tag, args.includes('--dry-run'));
}
