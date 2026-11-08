import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../env.ts';
import { putJson } from '../s3.ts';
import { startCrmSync, startTrackerItem } from '../temporal.ts';

/**
 * Alert-to-agent loop (docs/product-analytics.md): PostHog webhook destinations post here; the
 * worker opens or updates a tracker item (Plane by default, worker/tracker.py) for coding agents.
 * - `$insight_alert_firing` (a journey funnel fell below its threshold) -> producer `cjm-regression`
 * - `survey sent` from the "Report a problem" survey -> producer `from-users`
 * The item's text goes to S3 and only its key into the Temporal workflow (TrackerItemWorkflow).
 * - a body with `signal` (CRM product signals, config/crm.json, `pnpm crm:sync`) -> CrmSyncWorkflow
 * Survey answers are redacted first: by the Presidio sidecar when PII_REDACT_URL is set (compose
 * profile `pii`, docs/support.md "Personal data"), otherwise only emails are masked.
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
type Issue = { title: string; producer: 'cjm-regression' | 'from-users'; body: string };

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
// Fallback without the sidecar. Bounded, unambiguous pattern (no polynomial backtracking).
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g;
export class RedactionUnavailable extends Error {}

/** PII-free copies of `texts`. Throws RedactionUnavailable if the sidecar does not answer. */
export async function redact(texts: string[]): Promise<string[]> {
  const cut = texts.map((t) => t.slice(0, 10_000));
  if (!env.PII_REDACT_URL) return cut.map((t) => t.replace(EMAIL, '[email]'));
  if (!cut.length) return cut;
  try {
    const res = await fetch(`${env.PII_REDACT_URL}/redact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: cut }),
      signal: AbortSignal.timeout(10_000),
    });
    const out = res.ok ? ((await res.json()) as { texts?: unknown }).texts : undefined;
    if (
      Array.isArray(out) &&
      out.length === cut.length &&
      out.every((t) => typeof t === 'string')
    ) {
      // Same email pattern after Presidio: it misses addresses in paths and query strings.
      return out.map((t) => t.replace(EMAIL, '[email]'));
    }
    throw new Error(`status ${res.status}`);
  } catch (err) {
    throw new RedactionUnavailable(`PII redaction failed: ${(err as Error).name}`);
  }
}
const posthogUrl = (path: string) =>
  env.POSTHOG_APP_HOST && env.POSTHOG_PROJECT_ID
    ? `${env.POSTHOG_APP_HOST}/project/${env.POSTHOG_PROJECT_ID}/${path}`
    : undefined;
const agentHint = [
  '',
  '---',
  'For the agent: journeys are defined in `config/journeys.json`; `pnpm journeys:report` prints',
  'the current funnels; the PostHog MCP (`.mcp.json.example`) can query events, replays and',
  'errors for the affected step. Fix the cause, then close this item from the PR (Plane:',
  '`Fixes PROJ-123` in the title or body; docs/releases.md).',
];

/** Maps a PostHog event to the issue it should produce, or undefined to ignore it. */
export async function toIssue(e: z.infer<typeof Hook>['event']): Promise<Issue | undefined> {
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
    const questions: { question?: string; response?: unknown }[] = Array.isArray(
      p.$survey_questions,
    )
      ? p.$survey_questions
      : [];
    const redacted = await redact(questions.map((q) => str(q.response)));
    const answers = questions
      .map((q, i) => ({ q: str(q.question), a: redacted[i]!.trim() }))
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
      let issue: Issue | undefined;
      try {
        issue = await toIssue(event);
      } catch (err) {
        if (!(err instanceof RedactionUnavailable)) throw err;
        // Fail closed: no unredacted text goes anywhere. PostHog shows the failed delivery.
        req.log.warn('posthog hook: PII redaction sidecar unavailable, nothing filed');
        return reply.code(503).send({ error: 'pii redaction unavailable' });
      }
      if (!issue) return { action: 'ignored' };
      // Same text, same key and workflow id: a redelivered webhook files nothing twice.
      const hash = createHash('sha256').update(JSON.stringify(issue)).digest('hex');
      const item = { producer: issue.producer, s3Key: `tracker-inbox/${hash}.json` };
      await putJson(item.s3Key, { title: issue.title, body: issue.body });
      const started = await startTrackerItem(item, hash);
      req.log.info({ producer: issue.producer, started }, 'posthog hook -> tracker item workflow');
      return {
        action: started ? 'started' : 'duplicate',
        producer: issue.producer,
        key: item.s3Key,
      };
    },
  );
};
