import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../env.ts';
import { type Tracker, trackerFromEnv } from '../tracker.ts';

/**
 * Alert-to-agent loop (docs/product-analytics.md): PostHog webhook destinations post here, we
 * open or update a tracker item (Plane by default, src/tracker.ts) that coding agents pick up.
 * - `$insight_alert_firing` (a journey funnel fell below its threshold) -> producer `cjm-regression`
 * - `survey sent` from the "Report a problem" survey -> producer `from-users`
 * Without tracker credentials it is a dry run: the response shows the planned item.
 */
const Hook = z.object({
  event: z.object({
    event: z.string(),
    distinct_id: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).default({}),
  }),
});
type Issue = { title: string; producer: 'cjm-regression' | 'from-users'; body: string };

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
  'errors for the affected step. Fix the cause, then reference this item in the PR (Plane: its',
  '`PROJ-123` identifier in the title or body; docs/releases.md).',
];

/** Maps a PostHog event to the issue it should produce, or undefined to ignore it. */
export function toIssue(e: z.infer<typeof Hook>['event']): Issue | undefined {
  const p = e.properties;
  if (e.event === '$insight_alert_firing') {
    const insight = posthogUrl(`insights/${str(p.insight_id)}`);
    return {
      title: `[cjm] ${str(p.alert_name)}`,
      producer: 'cjm-regression',
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
      producer: 'from-users',
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

/** Comments on the producer's open item with the same title, or files a new one. */
async function upsertIssue(tracker: Tracker, issue: Issue) {
  const existing = await tracker.findOpen(issue.producer, issue.title);
  if (existing) {
    await tracker.comment(existing.ref, issue.body);
    return { action: 'commented' as const, ...existing };
  }
  return {
    action: 'created' as const,
    ...(await tracker.create(issue.producer, issue.title, issue.body)),
  };
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
      const issue = toIssue(req.body.event);
      if (!issue) return { action: 'ignored' };
      const tracker = trackerFromEnv(env);
      if (!tracker) return { action: 'dry-run', ...issue };
      const result = await upsertIssue(tracker, issue);
      req.log.info({ ...result, producer: issue.producer }, `posthog hook -> ${tracker.name} item`);
      return result;
    },
  );
};
