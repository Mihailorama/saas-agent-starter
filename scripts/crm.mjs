#!/usr/bin/env node
// CRM setup as code (docs/crm.md).  pnpm crm:sync [--dry-run]
//   Twenty (TWENTY_API_URL + TWENTY_API_KEY): the custom fields the worker's sync writes (the
//   cross-links and productSignals) and the extra deal stages from config/crm.json.
//   PostHog (journeys:sync's env + PUBLIC_API_URL, POSTHOG_WEBHOOK_SECRET): one webhook
//   destination per product signal -> POST /api/hooks/posthog.
// Only adds what is missing; never changes or removes a field, option or destination you edited.
// Without credentials (or with --dry-run) it prints the planned requests.
import { readFileSync } from 'node:fs';
import { client, posthogBase, posthogReady, upsert, webhook } from './journeys.mjs';

const crm = JSON.parse(readFileSync(new URL('../config/crm.json', import.meta.url), 'utf8'));
const e = process.env; // journeys.mjs has loaded .env / .env.example

const description = 'Set by the app sync (docs/crm.md); do not edit by hand.';
export const FIELDS = [
  { object: 'person', name: 'appUserId', label: 'App user id' },
  { object: 'company', name: 'appOrgId', label: 'App organization id' },
  { object: 'opportunity', name: 'appOrgId', label: 'App organization id' },
  { object: 'note', name: 'appEventId', label: 'App event id' },
];

const withPositions = (existing, added) =>
  added.map((o, i) => ({ color: 'green', ...o, position: existing.length + i }));

/** Requests that bring Twenty's metadata (GET /rest/metadata/objects) up to config/crm.json. */
export function twentyPlan(objects, config = crm) {
  const byName = Object.fromEntries(objects.map((o) => [o.nameSingular, o]));
  const objectId = (o) => byName[o]?.id ?? `<${o} object id>`;
  const field = (o, name) => byName[o]?.fields?.find((f) => f.name === name);
  const create = (o, body) => ({
    method: 'POST',
    path: '/metadata/fields',
    body: { objectMetadataId: objectId(o), description, ...body },
  });
  const addOptions = (f, wanted) => {
    const missing = wanted.filter((w) => !f.options?.some((o) => o.value === w.value));
    const options = [...(f.options ?? []), ...withPositions(f.options ?? [], missing)];
    return missing.length
      ? [{ method: 'PATCH', path: `/metadata/fields/${f.id}`, body: { options } }]
      : [];
  };
  const ops = FIELDS.filter((f) => !field(f.object, f.name)).map((f) =>
    create(f.object, { type: 'TEXT', name: f.name, label: f.label, isUnique: true }),
  );
  const signals = config.signals.map((s) => ({ value: s.name, label: s.label }));
  const tags = field('company', 'productSignals');
  if (tags) ops.push(...addOptions(tags, signals));
  else {
    ops.push(
      create('company', {
        type: 'MULTI_SELECT',
        name: 'productSignals',
        label: 'Product signals',
        options: withPositions([], signals),
      }),
    );
  }
  const stage = field('opportunity', 'stage');
  if (stage) ops.push(...addOptions(stage, config.stageOptions));
  else if (objects.length) throw new Error('Twenty has no opportunity.stage field');
  return ops;
}

/** PostHog destination: the signal's event -> the app API, which starts the CRM sync. */
export function signalHook(s) {
  const base = webhook(`CRM signal: ${s.label}`, { events: [{ id: s.event, type: 'events' }] });
  return {
    ...base,
    description: 'Managed by pnpm crm:sync (config/crm.json). Tags the company in the CRM.',
    inputs: { ...base.inputs, body: { value: { event: '{event}', signal: s.name } } },
  };
}

async function syncTwenty(dryRun) {
  const ready = Boolean(e.TWENTY_API_URL && e.TWENTY_API_KEY);
  console.log(
    `Twenty ${ready ? e.TWENTY_API_URL : '(TWENTY_API_URL / TWENTY_API_KEY not set: dry run)'}`,
  );
  const base = `${(e.TWENTY_API_URL || '<twenty>').replace(/\/+$/, '')}/rest`;
  const api = client(base, ready ? e.TWENTY_API_KEY : '', dryRun || !ready);
  const { data: objects = [] } = await api('GET', '/metadata/objects?limit=200');
  const ops = twentyPlan(objects);
  for (const op of ops) await api(op.method, op.path, op.body);
  console.log(`  ${ops.length} change(s)${api.dryRun ? ' planned' : ' applied'}`);
}

async function syncPosthog(dryRun) {
  if (!(e.PUBLIC_API_URL && e.POSTHOG_WEBHOOK_SECRET)) {
    console.log(
      'PostHog: skipped signal destinations: set PUBLIC_API_URL and POSTHOG_WEBHOOK_SECRET',
    );
    return;
  }
  const ready = posthogReady();
  console.log(`PostHog ${ready ? posthogBase() : '(not configured: dry run)'}`);
  const api = client(posthogBase(), ready ? e.POSTHOG_PERSONAL_API_KEY : '', dryRun || !ready);
  for (const s of crm.signals) {
    const body = signalHook(s);
    await upsert(api, {
      list: `/hog_functions/?search=${encodeURIComponent(body.name)}`,
      create: '/hog_functions/',
      name: body.name,
      body,
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...flags] = process.argv.slice(2);
  if (cmd !== 'sync') {
    console.error('usage: crm.mjs sync [--dry-run]');
    process.exit(1);
  }
  await syncTwenty(flags.includes('--dry-run'));
  await syncPosthog(flags.includes('--dry-run'));
}
