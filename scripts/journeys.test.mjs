// node --test 'scripts/*.test.mjs'  (part of pnpm check:ts). Pure parts of journeys.mjs: no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aiSurvey,
  alert,
  checkSurveys,
  contains,
  funnelQuery,
  insight,
  survey,
  surveyChanges,
  umamiFunnel,
  webhook,
} from './journeys.mjs';

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

const nps = {
  id: 'nps',
  type: 'nps',
  question: 'How likely are you to recommend us?',
  followUp: 'Why?',
  trigger: { url: '/projects/' },
  activeForDays: 14,
  waitDays: 30,
  repeat: { everyDays: 90, times: 4 },
  flag: 'nps-survey',
};
const csat = {
  id: 'csat',
  type: 'csat',
  question: 'How satisfied are you?',
  trigger: { event: 'project_created' },
  flag: 'csat-survey',
};

test('NPS survey -> 0-10 popover on a URL, recurring, linked flag, active users only', () => {
  const s = survey(nps, 7);
  assert.equal(s.type, 'popover');
  assert.equal(s.linked_flag_id, 7);
  assert.deepEqual(
    [s.questions[0].scale, s.questions[0].display, s.questions[1].type],
    [10, 'number', 'open'],
  );
  assert.deepEqual(s.conditions, {
    url: '/projects/',
    urlMatchType: 'icontains',
    seenSurveyWaitPeriodInDays: 30,
  });
  assert.equal(s.targeting_flag_filters.groups[0].properties[0].value, '-14d');
  assert.deepEqual(
    [s.schedule, s.iteration_count, s.iteration_frequency_days],
    ['recurring', 4, 90],
  );
  assert.ok(s.start_date);
});

test('CSAT survey -> 1-5 after a catalog event, asked once; update keeps question ids', () => {
  const s = survey(csat, 8, { questions: [{ id: 'q1', type: 'rating', scale: 5 }] });
  assert.equal(s.questions[0].scale, 5);
  assert.equal(s.questions[0].id, 'q1');
  assert.deepEqual(s.conditions.events.values, [{ name: 'project_created' }]);
  assert.equal(s.schedule, 'once');
  assert.equal(s.start_date, undefined); // an update must not restart the survey
  assert.equal(s.targeting_flag_filters, undefined);
  assert.ok(contains({ ...s, id: 'x', extra: 1 }, s)); // what PostHog returns -> unchanged
  assert.ok(
    !contains(
      s,
      survey({ ...csat, waitDays: 7 }, 8, { questions: [{ id: 'q1', type: 'rating', scale: 5 }] }),
    ),
  );
});

test('survey config errors', () => {
  const events = { project_created: { pii: false }, signup_completed: { pii: true } };
  const flags = { 'nps-survey': {}, 'csat-survey': {} };
  assert.deepEqual(checkSurveys([nps, csat], events, flags), []);
  assert.deepEqual(
    checkSurveys(
      [
        { ...csat, type: 'stars', trigger: { event: 'signup_completed' }, flag: 'nope' },
        { ...csat, trigger: {}, repeat: { everyDays: 0, times: 1.5 } },
      ],
      events,
      flags,
    ),
    [
      'surveys: csat: type must be nps or csat',
      'surveys: csat: trigger event "signup_completed" is pii, so it never reaches PostHog',
      'surveys: csat: flag "nope" is not in config/flags.json',
      'surveys: csat: id must be unique, lowercase and dash-separated',
      'surveys: csat: trigger needs an event and/or a url',
      'surveys: csat: day counts must be whole numbers',
      'surveys: csat: repeat needs everyDays and times above 0',
    ],
  );
});

// What PostHog returns for a synced survey: targeting_flag instead of the write-only filters.
const stored = (want) => {
  const { targeting_flag_filters, ...rest } = want;
  return {
    ...rest,
    id: 'x',
    targeting_flag: targeting_flag_filters && { filters: targeting_flag_filters },
  };
};

test('survey sync: unchanged when PostHog holds the same survey', () => {
  const have = stored(survey(nps, 7));
  assert.deepEqual(surveyChanges(have, survey(nps, 7, have)), []);
});

test('survey sync: a removed trigger url or activeForDays is a change', () => {
  const have = stored(survey(nps, 7));
  const noUrl = { ...nps, trigger: { event: 'project_created' } };
  assert.deepEqual(surveyChanges(have, survey(noUrl, 7, have)), ['conditions']);
  const anyone = { ...nps, activeForDays: undefined };
  const want = survey(anyone, 7, have);
  assert.equal(want.remove_targeting_flag, true);
  assert.equal(want.targeting_flag_filters, undefined);
  assert.deepEqual(surveyChanges(have, want), ['remove_targeting_flag']);
  // Once removed, PostHog returns no targeting_flag and nothing is sent again.
  const after = { ...have, targeting_flag: null };
  assert.deepEqual(surveyChanges(after, survey(anyone, 7, after)), []);
});

test('survey sync: question id kept only for the same kind of answer', () => {
  const have = {
    questions: [
      { id: 'q1', type: 'rating', scale: 10 },
      { id: 'q2', type: 'open' },
    ],
  };
  const asNps = survey(nps, 7, have).questions;
  assert.deepEqual([asNps[0].id, asNps[1].id], ['q1', 'q2']);
  const asCsat = survey({ ...nps, type: 'csat' }, 7, have).questions;
  assert.deepEqual([asCsat[0].id, asCsat[1].id], [undefined, 'q2']);
});
