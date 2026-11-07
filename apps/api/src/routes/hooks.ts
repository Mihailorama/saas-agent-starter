import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../env.ts';
import { startCrmSync } from '../temporal.ts';

/**
 * Alert-to-agent loop (docs/product-analytics.md): PostHog webhook destinations post here, we
 * open or update a GitHub issue that coding agents pick up.
 * - `$insight_alert_firing` (a journey funnel fell below its threshold) -> label `cjm-regression`
 * - `survey sent` from the "Report a problem" survey -> label `from-users`
 * Without GITHUB_TOKEN/GITHUB_REPO it is a dry run: the response shows the planned issue.
 * - a body with `signal` (CRM product signals, config/crm.json, `pnpm crm:sync`) -> CrmSyncWorkflow
 */
const Hook = z.object({
  event: z.object({
    uuid: z.string().optional(),
    event: z.string(),
    distinct_id: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).default({}),
  }),
  signal: z.string().max(64).optional(),
});
type Issue = { title: string; label: string; body: string };

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
// Bounded, unambiguous pattern (no polynomial backtracking on hostile input).
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g;
const scrub = (s: string) => s.slice(0, 10_000).replace(EMAIL, '[email]');
const posthogUrl = (path: string) =>
  env.POSTHOG_APP_HOST && env.POSTHOG_PROJECT_ID
    ? `${env.POSTHOG_APP_HOST}/project/${env.POSTHOG_PROJECT_ID}/${path}`
    : undefined;
const agentHint = [
  '',
  '---',
  'For the agent: journeys are defined in `config/journeys.json`; `pnpm journeys:report` prints',
  'the current funnels; the PostHog MCP (`.mcp.json.example`) can query events, replays and',
  'errors for the affected step. Fix the cause, then reference this issue in the PR.',
];

/** Maps a PostHog event to the issue it should produce, or undefined to ignore it. */
export function toIssue(e: z.infer<typeof Hook>['event']): Issue | undefined {
  const p = e.properties;
  if (e.event === '$insight_alert_firing') {
    const insight = posthogUrl(`insights/${str(p.insight_id)}`);
    return {
      title: `[cjm] ${str(p.alert_name)}`,
      label: 'cjm-regression',
      body: [
        `PostHog alert **${str(p.alert_name)}** fired on insight **${str(p.insight_name)}**.`,
        '',
        `- State: ${str(p.state)}`,
        `- Checked: ${str(p.last_checked_at)}`,
        ...(insight ? [`- Insight: ${insight}`] : []),
        '',
        'Breaches:',
        '```',
        str(p.breaches),
        '```',
        ...agentHint,
      ].join('\n'),
    };
  }
  // Thumbs on AI answers ($ai_trace_id) stay in PostHog AI observability; only free-text
  // reports from the feedback survey become issues.
  if (e.event === 'survey sent' && !p.$ai_trace_id) {
    const answers = (Array.isArray(p.$survey_questions) ? p.$survey_questions : [])
      .map((q: { question?: string; response?: unknown }) => ({
        q: str(q.question),
        a: scrub(str(q.response)).trim(),
      }))
      .filter((x) => x.a);
    if (!answers.length) return undefined;
    const replay = p.$session_id ? posthogUrl(`replay/${str(p.$session_id)}`) : undefined;
    const first = answers[0]!.a.replace(/\s+/g, ' ');
    return {
      title: `[feedback] ${first.length > 70 ? `${first.slice(0, 70)}…` : first}`,
      label: 'from-users',
      body: [
        `User feedback from survey **${str(p.$survey_name)}**.`,
        '',
        ...answers.flatMap((x) => [`> **${x.q}**`, `> ${x.a.replace(/\n/g, '\n> ')}`, '']),
        `- Page: ${str(p.$pathname || p.$current_url)}`,
        `- Release: ${str(p.release)}`,
        ...(replay ? [`- Session replay: ${replay}`] : []),
        ...agentHint,
      ].join('\n'),
    };
  }
  return undefined;
}

async function github(path: string, init?: { method: string; body: object }) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init && { 'content-type': 'application/json' }),
    },
    body: init && JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`GitHub ${init?.method ?? 'GET'} ${path}: ${res.status}`);
  return res.json();
}

/** Comments on the open issue with the same title and label, or opens a new one. */
async function upsertIssue(issue: Issue) {
  const open = (await github(
    `/issues?state=open&per_page=100&labels=${encodeURIComponent(issue.label)}`,
  )) as { number: number; title: string }[];
  const existing = open.find((i) => i.title === issue.title);
  if (existing) {
    await github(`/issues/${existing.number}/comments`, {
      method: 'POST',
      body: { body: issue.body },
    });
    return { action: 'commented' as const, issue: existing.number };
  }
  const created = (await github('/issues', {
    method: 'POST',
    body: { title: issue.title, body: issue.body, labels: [issue.label] },
  })) as { number: number };
  return { action: 'created' as const, issue: created.number };
}

const sameSecret = (given: string | undefined) => {
  const want = Buffer.from(env.POSTHOG_WEBHOOK_SECRET ?? '');
  const got = Buffer.from(given ?? '');
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
};

export const hookRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/posthog',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { hide: true, body: Hook },
    },
    async (req, reply) => {
      if (!sameSecret(req.headers['x-webhook-secret'] as string | undefined)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { event, signal } = req.body;
      if (signal) {
        // The worker decides whether the user's organizations qualify (members, plan).
        if (!event.uuid || !event.distinct_id) return { action: 'ignored' };
        const started = await startCrmSync({
          kind: 'signal',
          eventId: `posthog:${event.uuid}`,
          userId: event.distinct_id,
          signal,
        });
        return { action: started ? 'started' : 'duplicate' };
      }
      const issue = toIssue(event);
      if (!issue) return { action: 'ignored' };
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return { action: 'dry-run', ...issue };
      const result = await upsertIssue(issue);
      req.log.info({ ...result, label: issue.label }, 'posthog hook -> github issue');
      return result;
    },
  );
};
