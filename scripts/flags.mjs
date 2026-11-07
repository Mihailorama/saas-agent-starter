#!/usr/bin/env node
// Feature flags as code (docs/feature-flags.md).
//   pnpm flags:sync [--dry-run]   config/flags.json -> PostHog feature flags
// Creates missing flags at 100% (default true) or 0% (default false) rollout. An existing flag
// only gets its description updated: rollout and targeting are changed in PostHog, never here.
// Same env as journeys:sync; without credentials, or with --dry-run, it prints the plan.
import { readFileSync } from 'node:fs';
import { client, posthogBase, posthogReady } from './journeys.mjs';

const { flags } = JSON.parse(
  readFileSync(new URL('../config/flags.json', import.meta.url), 'utf8'),
);

/** PostHog's "description" field of a flag is called `name` in its API. */
export const flagName = (f) =>
  `${f.description} Owner: ${f.owner}. Remove by ${f.expires}. Managed by pnpm flags:sync.`;

export const newFlag = (key, f) => ({
  key,
  name: flagName(f),
  active: true,
  filters: { groups: [{ properties: [], rollout_percentage: f.default ? 100 : 0 }] },
});

async function sync(dryRun) {
  const ready = posthogReady();
  console.log(
    `PostHog ${ready ? posthogBase() : '(POSTHOG_APP_HOST / POSTHOG_PROJECT_ID / POSTHOG_PERSONAL_API_KEY not set: dry run)'}`,
  );
  const api = client(
    posthogBase(),
    ready ? process.env.POSTHOG_PERSONAL_API_KEY : '',
    dryRun || !ready,
  );
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, f] of Object.entries(flags)) {
    if (f.expires < today) console.warn(`  EXPIRED ${key} (${f.expires}, owner ${f.owner})`);
    const list = await api('GET', `/feature_flags/?search=${encodeURIComponent(key)}`);
    const found = (list.results ?? []).find((x) => x.key === key);
    if (!found) {
      await api('POST', '/feature_flags/', newFlag(key, f));
      console.log(`  ${api.dryRun ? 'would create' : 'created'} ${key}`);
    } else if (found.name !== flagName(f)) {
      await api('PATCH', `/feature_flags/${found.id}/`, { name: flagName(f) });
      console.log(`  ${api.dryRun ? 'would update' : 'updated'} ${key} (description only)`);
    } else {
      console.log(`  up to date ${key}`);
    }
  }
  if (!Object.keys(flags).length) console.log('  config/flags.json has no flags');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...opts] = process.argv.slice(2);
  if (cmd !== 'sync') {
    console.error('usage: flags.mjs sync [--dry-run]');
    process.exit(2);
  }
  await sync(opts.includes('--dry-run'));
}
