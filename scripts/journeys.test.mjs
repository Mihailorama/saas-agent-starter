// node --test 'scripts/*.test.mjs'  (part of pnpm check:ts). Pure parts of journeys.mjs: no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiSurvey, alert, funnelQuery, insight, umamiFunnel, webhook } from './journeys.mjs';

const j = {
  name: 'activation',
  description: 'Sign up to first project.',
  windowDays: 1,
  minConversion: 30,
  steps: [{ event: 'signup_started' }, { event: 'org_created', maxStepSeconds: 600 }],
};

test('journey -> PostHog funnel insight', () => {
  const q = funnelQuery(j);
  assert.deepEqual(
    q.series.map((s) => s.event),
    ['signup_started', 'org_created'],
  );
  assert.deepEqual(q.funnelsFilter, {
    funnelWindowInterval: 1,
    funnelWindowIntervalUnit: 'day',
    funnelVizType: 'steps',
    funnelOrderType: 'ordered',
  });
  assert.equal(insight(j).query.kind, 'InsightVizNode');
  assert.equal(insight(j).name, 'Journey: activation');
});

test('journey -> threshold alert on end-to-end conversion', () => {
  const a = alert(j, 42);
  assert.equal(a.insight, 42);
  assert.deepEqual(a.threshold.configuration, { type: 'absolute', bounds: { lower: 30 } });
  assert.deepEqual(a.config, {
    type: 'FunnelsAlertConfig',
    funnel_step: null,
    metric: 'conversion_from_start',
  });
});

test('AI feedback survey is a 2-point thumbs rating', () => {
  assert.deepEqual(aiSurvey().questions[0], {
    type: 'rating',
    display: 'emoji',
    scale: 2,
    question: 'Was this AI answer helpful?',
  });
});

test('webhook destination posts the event with the shared secret', () => {
  process.env.PUBLIC_API_URL = 'https://app.example.com';
  process.env.POSTHOG_WEBHOOK_SECRET = 'example-secret';
  const w = webhook('x', { source: 'internal-events', events: [] });
  assert.equal(w.type, 'internal_destination');
  assert.equal(w.inputs.headers.value['x-webhook-secret'], 'example-secret');
});

test('journey -> Umami funnel (window in minutes)', () => {
  assert.deepEqual(umamiFunnel(j).parameters, {
    window: 1440,
    steps: [
      { type: 'event', value: 'signup_started' },
      { type: 'event', value: 'org_created' },
    ],
  });
});
