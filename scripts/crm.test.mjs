// node --test 'scripts/*.test.mjs'. Pure parts of crm.mjs (pnpm crm:sync): no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIELDS, signalHook, twentyPlan } from './crm.mjs';

const config = {
  signals: [{ name: 'ACTIVE_TEAM_FREE', label: 'Active team', event: 'project_created' }],
  stageOptions: [{ value: 'CHURNED', label: 'Churned', color: 'gray' }],
};
const stage = { id: 'f-stage', name: 'stage', options: [{ value: 'NEW', position: 0 }] };
const objects = (extra = {}) =>
  ['person', 'company', 'opportunity', 'note'].map((o) => ({
    id: `id-${o}`,
    nameSingular: o,
    fields: [...(o === 'opportunity' ? [stage] : []), ...(extra[o] ?? [])],
  }));

test('fresh workspace: every custom field, the signal tags and the extra stages', () => {
  const ops = twentyPlan(objects(), config);
  const created = ops.filter((o) => o.method === 'POST').map((o) => o.body);
  assert.deepEqual(
    created.map((b) => `${b.objectMetadataId}.${b.name}`),
    [...FIELDS.map((f) => `id-${f.object}.${f.name}`), 'id-company.productSignals'],
  );
  assert.ok(created.slice(0, 4).every((b) => b.type === 'TEXT' && b.isUnique));
  assert.deepEqual(created[4].options, [
    { color: 'green', value: 'ACTIVE_TEAM_FREE', label: 'Active team', position: 0 },
  ]);
  const [patch] = ops.filter((o) => o.method === 'PATCH');
  assert.equal(patch.path, '/metadata/fields/f-stage');
  assert.deepEqual(
    patch.body.options.map((o) => [o.value, o.position]),
    [
      ['NEW', 0],
      ['CHURNED', 1],
    ],
  );
});

test('up to date: nothing to do; a new signal only adds its option', () => {
  const have = (o) => FIELDS.filter((f) => f.object === o).map((f) => ({ name: f.name }));
  const tags = { id: 'f-tags', name: 'productSignals', options: [{ value: 'ACTIVE_TEAM_FREE' }] };
  const done = objects({
    person: have('person'),
    company: [...have('company'), tags],
    opportunity: [...have('opportunity')],
    note: have('note'),
  });
  done[2].fields[0] = { ...stage, options: [...stage.options, { value: 'CHURNED' }] };
  assert.deepEqual(twentyPlan(done, config), []);
  const more = { ...config, signals: [...config.signals, { name: 'POWER_USER', label: 'Power' }] };
  assert.deepEqual(twentyPlan(done, more), [
    {
      method: 'PATCH',
      path: '/metadata/fields/f-tags',
      body: {
        options: [
          { value: 'ACTIVE_TEAM_FREE' },
          { color: 'green', value: 'POWER_USER', label: 'Power', position: 1 },
        ],
      },
    },
  ]);
});

test('signal -> PostHog webhook destination carrying the signal name', () => {
  const hook = signalHook(config.signals[0]);
  assert.equal(hook.name, 'CRM signal: Active team');
  assert.deepEqual(hook.filters, { events: [{ id: 'project_created', type: 'events' }] });
  assert.deepEqual(hook.inputs.body.value, { event: '{event}', signal: 'ACTIVE_TEAM_FREE' });
  assert.match(hook.inputs.url.value, /\/api\/hooks\/posthog$/);
});
