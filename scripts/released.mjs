#!/usr/bin/env node
// node scripts/released.mjs <tag> [--dry-run]   (docs/releases.md; run by .github/workflows/released.yml)
// For every PR merged between the previous v* tag and <tag>, comments "Released in <tag>" on the
// issues that PR closed (closing keywords: "Closes #12") and labels them `released`. Idempotent:
// an issue that already has the comment for this tag is skipped.
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name; defaults to the origin remote).
import { execFileSync } from 'node:child_process';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const LABEL = 'released';
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

async function github(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok && !(method === 'POST' && path.endsWith('/labels') && res.status === 422)) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? {} : res.json();
}

const CLOSING = `query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $pr) {
    closingIssuesReferences(first: 50) { nodes { number repository { nameWithOwner } } } } } }`;

async function main(tag, dryRun) {
  const repo =
    process.env.GITHUB_REPOSITORY ??
    git('remote', 'get-url', 'origin').match(/github\.com[:/](.+?)(\.git)?$/)?.[1];
  const [owner, name] = repo.split('/');
  const { prev, shas } = releaseCommits(tag);
  console.log(`${tag}: ${shas.length} commits since ${prev ?? 'the first commit'} in ${repo}`);

  const prs = new Set();
  for (const sha of shas) {
    for (const pr of await github('GET', `/repos/${repo}/commits/${sha}/pulls`)) {
      if (pr.merged_at) prs.add(pr.number);
    }
  }
  const issues = new Map(); // issue number -> PR that closed it
  for (const pr of prs) {
    const { data, errors } = await github('POST', '/graphql', {
      query: CLOSING,
      variables: { owner, name, pr },
    });
    if (errors) throw new Error(`graphql PR #${pr}: ${JSON.stringify(errors)}`);
    for (const i of data.repository.pullRequest.closingIssuesReferences.nodes) {
      if (i.repository.nameWithOwner === repo && !issues.has(i.number)) issues.set(i.number, pr);
    }
  }
  console.log(`  ${prs.size} merged PRs, ${issues.size} closed issues`);
  if (!issues.size) return;
  if (!dryRun) {
    await github('POST', `/repos/${repo}/labels`, {
      name: LABEL,
      color: '0e8a16',
      description: 'Shipped in a published release (comment names the version)',
    }); // 422 = already exists
  }
  for (const [issue, pr] of issues) {
    const body = releasedComment(tag, pr, repo);
    const comments = await github('GET', `/repos/${repo}/issues/${issue}/comments?per_page=100`);
    if (comments.some((c) => c.body.startsWith(`Released in ${tag} `))) {
      console.log(`  #${issue}: already commented`);
    } else if (dryRun) {
      console.log(`  PLAN #${issue}: comment "${body}" + label ${LABEL}`);
    } else {
      await github('POST', `/repos/${repo}/issues/${issue}/comments`, { body });
      await github('POST', `/repos/${repo}/issues/${issue}/labels`, { labels: [LABEL] });
      console.log(`  #${issue}: commented and labelled`);
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
