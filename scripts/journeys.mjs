#!/usr/bin/env node
// Customer journeys as code (docs/product-analytics.md).
//   pnpm journeys:sync [--dry-run]   config/journeys.json -> PostHog funnels + alerts + surveys +
//                                    webhook destinations, and Umami funnels
//   pnpm journeys:report [--json]    current funnel numbers from PostHog / Umami
// Each tool is used only when its env is set; without credentials `sync` prints the plan.
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(new URL(file, root));
  } catch {}
}
const { journeys } = JSON.parse(readFileSync(new URL('config/journeys.json', root), 'utf8'));
const e = process.env;
const TAG = 'journeys-as-code';
export const names = {
  insight: (j) => `Journey: ${j.name}`,
  alert: (j) => `Journey ${j.name}: conversion below ${j.minConversion}%`,
  problemSurvey: 'Report a problem / suggest an improvement',
  aiSurvey: 'AI answer feedback',
  alertHook: 'Journey alerts -> GitHub issues',
  surveyHook: 'User feedback -> GitHub issues',
};

// ---- Desired objects (pure; covered by scripts/journeys.test.mjs) ----

export const funnelQuery = (j, dateFrom = '-14d') => ({
  kind: 'FunnelsQuery',
  series: j.steps.map((s) => ({ kind: 'EventsNode', event: s.event, name: s.event })),
  funnelsFilter: {
    funnelWindowInterval: j.windowDays,
    funnelWindowIntervalUnit: 'day',
    funnelVizType: 'steps',
    funnelOrderType: 'ordered',
  },
  dateRange: { date_from: dateFrom },
  filterTestAccounts: true,
});

export const insight = (j) => ({
  name: names.insight(j),
  description: `${j.description} Managed by pnpm journeys:sync (config/journeys.json).`,
  tags: [TAG],
  query: { kind: 'InsightVizNode', source: funnelQuery(j) },
});

// Threshold alert on the whole funnel: fires when first-to-last conversion < minConversion %.
export const alert = (j, insightId) => ({
  name: names.alert(j),
  insight: insightId,
  enabled: true,
  subscribed_users: [],
  calculation_interval: 'hourly',
  threshold: { configuration: { type: 'absolute', bounds: { lower: j.minConversion } } },
  condition: { type: 'absolute_value' },
  config: { type: 'FunnelsAlertConfig', funnel_step: null, metric: 'conversion_from_start' },
});

// "Report a problem" lives in PostHog Surveys as a feedback tab on every page.
export const problemSurvey = () => ({
  name: names.problemSurvey,
  description: `Feedback widget. Managed by pnpm journeys:sync. Responses become GitHub issues (from-users).`,
  type: 'widget',
  appearance: { widgetType: 'tab', widgetLabel: 'Feedback' },
  questions: [
    {
      type: 'open',
      question: 'What went wrong, or what would make this better?',
      description: 'Sent to the product team with the page you are on.',
    },
  ],
  start_date: new Date().toISOString(),
});

// Thumbs up/down on AI answers, shown by our own buttons (API survey), attached to the trace.
export const aiSurvey = () => ({
  name: names.aiSurvey,
  description: 'Thumbs on AI results ($ai_trace_id). Managed by pnpm journeys:sync.',
  type: 'api',
  questions: [
    { type: 'rating', display: 'emoji', scale: 2, question: 'Was this AI answer helpful?' },
  ],
  start_date: new Date().toISOString(),
});

// Webhook destination (PostHog CDP) that posts the event to our API's /api/hooks/posthog.
export const webhook = (name, filters) => ({
  name,
  description: 'Managed by pnpm journeys:sync. Opens or updates GitHub issues via the app API.',
  type: filters.source === 'internal-events' ? 'internal_destination' : 'destination',
  template_id: 'template-webhook',
  enabled: true,
  inputs: {
    url: { value: `${e.PUBLIC_API_URL}/api/hooks/posthog` },
    method: { value: 'POST' },
    body: { value: { event: '{event}' } },
    headers: {
      value: { 'Content-Type': 'application/json', 'x-webhook-secret': e.POSTHOG_WEBHOOK_SECRET },
    },
  },
  filters,
});

export const umamiFunnel = (j) => ({
  name: `Journey: ${j.name}`,
  description: j.description,
  parameters: {
    window: j.windowDays * 24 * 60, // minutes
    steps: j.steps.map((s) => ({ type: 'event', value: s.event })),
  },
});

// ---- HTTP clients; a dry-run client prints writes instead of sending them ----

export function client(base, key, dryRun) {
  const api = async (method, path, body) => {
    if (dryRun && method !== 'GET') {
      console.log(
        `  PLAN ${method} ${path}\n${JSON.stringify(body, (k, v) => (/secret|authorization/i.test(k) ? '***' : v), 2).replace(/^/gm, '    ')}`,
      );
      return { id: `<new ${path.split('/').filter(Boolean)[0]}>`, questions: [{ id: '<new>' }] };
    }
    if (!key) return { results: [], data: [] }; // dry run without credentials: nothing exists
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  };
  return Object.assign(api, { dryRun });
}

export const posthogBase = () =>
  `${e.POSTHOG_APP_HOST}/api/projects/${e.POSTHOG_PROJECT_ID || '<project>'}`;
export const posthogReady = () =>
  Boolean(e.POSTHOG_APP_HOST && e.POSTHOG_PROJECT_ID && e.POSTHOG_PERSONAL_API_KEY);
const umamiBase = () => `${e.UMAMI_URL}/api/websites/${e.UMAMI_WEBSITE_ID || '<website>'}`;
const umamiReady = () => Boolean(e.UMAMI_URL && e.UMAMI_API_KEY && e.UMAMI_WEBSITE_ID);

/** Finds an object by exact name in a list endpoint, then PATCHes/POSTs or creates it. */
export async function upsert(
  api,
  {
    list,
    create,
    update = (id) => `${create}${id}/`,
    key = 'results',
    name,
    body,
    method = 'PATCH',
    createOnly = false,
  },
) {
  const found = ((await api('GET', list))[key] ?? []).find((x) => x.name === name);
  if (found && createOnly) {
    console.log(`  exists ${name} (left as is: edit it in PostHog)`);
    return found;
  }
  if (found) {
    const updated = await api(method, update(found.id), body);
    console.log(`  ${api.dryRun ? 'would update' : 'updated'} ${name}`);
    return { ...found, ...updated };
  }
  const created = await api('POST', create, body);
  console.log(`  ${api.dryRun ? 'would create' : 'created'} ${name}`);
  return created;
}

async function syncPosthog(dryRun) {
  const ready = posthogReady();
  console.log(
    `PostHog ${ready ? posthogBase() : '(POSTHOG_APP_HOST / POSTHOG_PROJECT_ID / POSTHOG_PERSONAL_API_KEY not set: dry run)'}`,
  );
  const api = client(posthogBase(), ready ? e.POSTHOG_PERSONAL_API_KEY : '', dryRun || !ready);
  const q = encodeURIComponent;
  for (const j of journeys) {
    const ins = await upsert(api, {
      list: `/insights/?saved=true&limit=100&search=${q(names.insight(j))}`,
      create: '/insights/',
      name: names.insight(j),
      body: insight(j),
    });
    await upsert(api, {
      list: `/alerts/?insight_id=${q(ins.id)}`,
      create: '/alerts/',
      name: names.alert(j),
      body: alert(j, ins.id),
    });
  }
  // With the Chatwoot widget configured, bug reports and ideas go through its Help menu
  // (docs/support.md): one entry point, so the PostHog feedback tab is not created.
  const supportWidget = Boolean(e.VITE_CHATWOOT_BASE_URL && e.VITE_CHATWOOT_WEBSITE_TOKEN);
  const problem = supportWidget
    ? undefined
    : await upsert(api, {
        list: `/surveys/?search=${q(names.problemSurvey)}`,
        create: '/surveys/',
        name: names.problemSurvey,
        body: problemSurvey(),
        createOnly: true, // question ids must stay stable; later edits happen in the PostHog UI
      });
  if (supportWidget) {
    console.log(
      `  skipped "${names.problemSurvey}": the Chatwoot Help menu takes reports; stop that survey in PostHog if it exists`,
    );
  }
  const ai = await upsert(api, {
    list: `/surveys/?search=${q(names.aiSurvey)}`,
    create: '/surveys/',
    name: names.aiSurvey,
    body: aiSurvey(),
    createOnly: true,
  });
  if (e.PUBLIC_API_URL && e.POSTHOG_WEBHOOK_SECRET) {
    const hook = (name, filters) =>
      upsert(api, {
        list: `/hog_functions/?search=${q(name)}`,
        create: '/hog_functions/',
        name,
        body: webhook(name, filters),
      });
    await hook(names.alertHook, {
      source: 'internal-events',
      events: [{ id: '$insight_alert_firing', type: 'events' }],
    });
    if (problem) {
      await hook(names.surveyHook, {
        events: [{ id: 'survey sent', type: 'events' }],
        properties: [{ key: '$survey_id', value: problem.id, operator: 'exact', type: 'event' }],
      });
    }
  } else {
    console.log('  skipped webhook destinations: set PUBLIC_API_URL and POSTHOG_WEBHOOK_SECRET');
  }
  console.log(
    `  web env for AI feedback: VITE_POSTHOG_AI_FEEDBACK_SURVEY_ID=${ai.id} VITE_POSTHOG_AI_FEEDBACK_QUESTION_ID=${ai.questions?.[0]?.id}`,
  );
}

async function syncUmami(dryRun) {
  const ready = umamiReady();
  console.log(
    `Umami ${ready ? umamiBase() : '(UMAMI_URL / UMAMI_API_KEY / UMAMI_WEBSITE_ID not set: dry run)'}`,
  );
  const api = client(umamiBase(), ready ? e.UMAMI_API_KEY : '', dryRun || !ready);
  for (const j of journeys) {
    const body = umamiFunnel(j);
    await upsert(api, {
      list: `/funnels?search=${encodeURIComponent(body.name)}`,
      key: 'data',
      create: '/funnels',
      update: (id) => `/funnels/${id}`,
      method: 'POST',
      name: body.name,
      body,
    });
  }
}

// ---- Report ----

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
const dur = (s) => (s == null ? '-' : s < 120 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`);

async function report(json) {
  const out = [];
  if (posthogReady()) {
    const api = client(posthogBase(), e.POSTHOG_PERSONAL_API_KEY, false);
    for (const j of journeys) {
      const list = await api(
        'GET',
        `/insights/?saved=true&search=${encodeURIComponent(names.insight(j))}`,
      );
      const found = list.results.find((x) => x.name === names.insight(j));
      if (!found) {
        out.push({
          tool: 'posthog',
          journey: j.name,
          error: 'insight missing: run pnpm journeys:sync',
        });
        continue;
      }
      const data = await api('GET', `/insights/${found.id}/?refresh=blocking`);
      const steps = (data.result ?? data.results ?? []).map((s, i) => ({
        event: s.name,
        count: s.count,
        medianSeconds: s.median_conversion_time ?? null,
        maxStepSeconds: j.steps[i]?.maxStepSeconds ?? null,
      }));
      out.push({ tool: 'posthog', journey: j.name, minConversion: j.minConversion, steps });
    }
  }
  if (umamiReady()) {
    const api = client(umamiBase(), e.UMAMI_API_KEY, false);
    const endAt = Date.now();
    const startAt = endAt - 14 * 86_400_000;
    for (const j of journeys) {
      const { data } = await api(
        'GET',
        `/funnels?search=${encodeURIComponent(`Journey: ${j.name}`)}`,
      );
      const found = data.find((x) => x.name === `Journey: ${j.name}`);
      if (!found) {
        out.push({
          tool: 'umami',
          journey: j.name,
          error: 'funnel missing: run pnpm journeys:sync',
        });
        continue;
      }
      const stats = await api(
        'GET',
        `/funnels/${found.id}/stats?startAt=${startAt}&endAt=${endAt}`,
      );
      const steps = stats.map((s, i) => ({
        event: s.value,
        count: s.visitors,
        medianSeconds: null,
        maxStepSeconds: j.steps[i]?.maxStepSeconds ?? null,
      }));
      out.push({ tool: 'umami', journey: j.name, minConversion: j.minConversion, steps });
    }
  }
  if (json) return console.log(JSON.stringify(out, null, 2));
  if (!out.length) console.log('No analytics backend configured (see docs/product-analytics.md).');
  for (const r of out) {
    if (r.error) {
      console.log(`${r.journey} (${r.tool}): ${r.error}`);
      continue;
    }
    const first = r.steps[0]?.count ?? 0;
    const last = r.steps.at(-1)?.count ?? 0;
    const low = first && (100 * last) / first < r.minConversion;
    console.log(
      `${r.journey} (${r.tool}, last 14 days): ${pct(last, first)} end to end, target >= ${r.minConversion}%${low ? '  << BELOW TARGET' : ''}`,
    );
    r.steps.forEach((s, i) => {
      const prev = i ? r.steps[i - 1].count : s.count;
      const slow =
        s.medianSeconds != null && s.maxStepSeconds && s.medianSeconds > s.maxStepSeconds;
      console.log(
        `  ${i + 1}. ${s.event.padEnd(24)} ${String(s.count).padStart(7)}  ${pct(s.count, prev).padStart(6)} of previous  median ${dur(s.medianSeconds)} (target ${dur(s.maxStepSeconds)})${slow ? '  << SLOW' : ''}`,
      );
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...flags] = process.argv.slice(2);
  if (cmd === 'sync') {
    await syncPosthog(flags.includes('--dry-run'));
    await syncUmami(flags.includes('--dry-run'));
  } else if (cmd === 'report') {
    await report(flags.includes('--json'));
  } else {
    console.error('usage: journeys.mjs sync [--dry-run] | report [--json]');
    process.exit(2);
  }
}
