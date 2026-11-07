import { createHmac, timingSafeEqual } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { env } from '../env.ts';
import { startCrmSync, startSupportIssueClosed, startSupportTriage } from '../temporal.ts';

/**
 * Service desk glue (docs/support.md, ADR 0013). Tickets live in Chatwoot, backlog items in the
 * tracker; nothing here stores either. Three signed webhooks start Temporal workflows (the worker
 * does the triage and the notes), and one endpoint signs the widget identity of a logged-in user.
 */

export const hmacHex = (key: string, data: string | Buffer) =>
  createHmac('sha256', key).update(data).digest('hex');
export const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const header = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');

/** Chatwoot: `X-Chatwoot-Signature: sha256=hex(HMAC(secret, "<timestamp>.<raw body>"))`. */
export function chatwootSigned(
  raw: Buffer,
  signature: string,
  timestamp: string,
  now = Date.now(),
) {
  const secret = env.CHATWOOT_WEBHOOK_SECRET;
  const ts = Number(timestamp);
  // Five minutes either way: a captured request cannot be replayed later.
  if (!secret || !Number.isInteger(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  return sameString(signature, `sha256=${hmacHex(secret, `${timestamp}.${raw}`)}`);
}
/** GitHub: `X-Hub-Signature-256: sha256=hex(HMAC(secret, raw body))`. */
export const githubSigned = (raw: Buffer, signature: string) =>
  Boolean(env.GITHUB_WEBHOOK_SECRET) &&
  sameString(signature, `sha256=${hmacHex(env.GITHUB_WEBHOOK_SECRET!, raw)}`);
/** Plane: `X-Plane-Signature: hex(HMAC(secret, raw body))`. */
export const planeSigned = (raw: Buffer, signature: string) =>
  Boolean(env.PLANE_WEBHOOK_SECRET) &&
  sameString(signature, hmacHex(env.PLANE_WEBHOOK_SECRET!, raw));

const ChatwootEvent = z.object({
  event: z.string(),
  id: z.number().int().optional(), // conversation_created: the conversation's display id
  message_type: z.string().optional(),
  private: z.boolean().optional(),
  account: z.object({ id: z.number().int() }).optional(),
  conversation: z.object({ id: z.number().int() }).optional(),
});
const GithubEvent = z.object({
  action: z.string().optional(), // absent on `ping`
  issue: z
    .object({
      number: z.number().int(),
      closed_at: z.string().nullable().optional(),
      labels: z.array(z.object({ name: z.string() })).default([]),
    })
    .optional(),
  comment: z.object({ body: z.string() }).optional(),
});
/** scripts/released.mjs comments `Released in vX.Y.Z (via #PR). ...` (docs/releases.md). */
const RELEASED = /^Released in (v[\w.+-]{1,40}) /;
const PlaneEvent = z.object({
  entity_type: z.string().optional(),
  event_id: z.string().optional(),
  data: z.object({ id: z.string().optional(), project_id: z.string().optional() }).default({}),
  previous_attributes: z.record(z.string(), z.unknown()).default({}),
});
const Result = z.object({ action: z.enum(['ignored', 'started', 'duplicate']) });
const ErrorBody = z.object({ error: z.string() });
export const hookResponses = { 200: Result, 401: ErrorBody };

/** Label the worker puts on every tracker item it creates or +1s (docs/support.md). */
export const SUPPORT_LABEL = 'support';

const rawBodies = new WeakMap<object, Buffer>();

/**
 * Replaces the JSON parser of an encapsulated plugin with one that keeps the exact bytes, since
 * signatures are over those. Returns the lookup for a request's raw body.
 */
export function keepRawJson(app: Parameters<FastifyPluginAsyncZod>[0]) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    rawBodies.set(req, body as Buffer);
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(Object.assign(new Error('invalid JSON'), { statusCode: 400 }), undefined);
    }
  });
  return (req: object) => rawBodies.get(req) ?? Buffer.alloc(0);
}

/** POST /api/hooks/{chatwoot,github,plane}. Encapsulated: its raw-body JSON parser stays here. */
export const supportHookRoutes: FastifyPluginAsyncZod = async (app) => {
  const raw = keepRawJson(app);
  const limits = { rateLimit: { max: 120, timeWindow: '1 minute' } };

  app.post(
    '/chatwoot',
    { config: limits, schema: { hide: true, body: ChatwootEvent, response: hookResponses } },
    async (req, reply) => {
      const ok = chatwootSigned(
        raw(req),
        header(req.headers['x-chatwoot-signature']),
        header(req.headers['x-chatwoot-timestamp']),
      );
      if (!ok) return reply.code(401).send({ error: 'unauthorized' });
      const e = req.body;
      // A new conversation is an activity on the person in the CRM (docs/crm.md).
      if (e.event === 'conversation_created' && e.account && e.id) {
        const started = await startCrmSync({
          kind: 'support.conversation',
          eventId: `chatwoot:${e.account.id}:${e.id}`,
          accountId: e.account.id,
          conversationId: e.id,
        });
        return { action: started ? ('started' as const) : ('duplicate' as const) };
      }
      // Only a customer's message starts a triage; agent replies and private notes do not.
      if (e.event !== 'message_created' || e.message_type !== 'incoming' || e.private) {
        return { action: 'ignored' as const };
      }
      if (!e.account || !e.conversation) return { action: 'ignored' as const };
      const c = { accountId: e.account.id, conversationId: e.conversation.id };
      const started = await startSupportTriage(c);
      req.log.info({ ...c, started }, 'chatwoot hook -> support triage');
      return { action: started ? ('started' as const) : ('duplicate' as const) };
    },
  );

  app.post(
    '/github',
    { config: limits, schema: { hide: true, body: GithubEvent, response: hookResponses } },
    async (req, reply) => {
      if (!githubSigned(raw(req), header(req.headers['x-hub-signature-256']))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { action, issue, comment } = req.body;
      const event = header(req.headers['x-github-event']);
      if (!issue?.labels.some((l) => l.name === SUPPORT_LABEL))
        return { action: 'ignored' as const };
      // "closed" means merged; the release comment means the fix is live in that version.
      const release =
        event === 'issue_comment' && action === 'created' && comment?.body.match(RELEASED)?.[1];
      if (!release && !(event === 'issues' && action === 'closed')) {
        return { action: 'ignored' as const };
      }
      const e = {
        tracker: 'github' as const,
        issueId: String(issue.number),
        release: release || '',
      };
      const closeId = release ? `release-${release}` : String(Date.parse(issue.closed_at ?? ''));
      const started = await startSupportIssueClosed(e, closeId);
      req.log.info({ ...e, started }, 'github hook -> support issue closed');
      return { action: started ? ('started' as const) : ('duplicate' as const) };
    },
  );

  app.post(
    '/plane',
    { config: limits, schema: { hide: true, body: PlaneEvent, response: hookResponses } },
    async (req, reply) => {
      if (!planeSigned(raw(req), header(req.headers['x-plane-signature']))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { entity_type, event_id, data, previous_attributes } = req.body;
      // A state change on a work item of our project; the worker checks the state group.
      const stateChanged = entity_type === 'issue' && 'state_id' in previous_attributes;
      const ours = !env.PLANE_PROJECT_ID || data.project_id === env.PLANE_PROJECT_ID;
      if (!stateChanged || !ours || !data.id || !event_id) return { action: 'ignored' as const };
      const e = { tracker: 'plane' as const, issueId: data.id };
      const started = await startSupportIssueClosed(e, event_id);
      req.log.info({ ...e, started }, 'plane hook -> support issue closed');
      return { action: started ? ('started' as const) : ('duplicate' as const) };
    },
  );
};

const Identity = z.object({
  identifier: z.string(),
  identifierHash: z.string(),
  name: z.string(),
  email: z.string(),
  orgId: z.string().nullable(),
});

/** GET /api/support/identity: what the web passes to the widget's `setUser`. */
export const supportRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/identity',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { response: { 200: Identity, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody } },
    },
    async (req, reply) => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return reply.code(401).send({ error: 'unauthorized' });
      // An operator viewing as the user must not write to support in their name (docs/admin.md).
      if (session.session.impersonatedBy) return reply.code(403).send({ error: 'forbidden' });
      if (!env.CHATWOOT_HMAC_TOKEN) return reply.code(404).send({ error: 'support is off' });
      const { user } = session;
      // Chatwoot recomputes this with the inbox's HMAC token: nobody can pose as another user.
      return {
        identifier: user.id,
        identifierHash: hmacHex(env.CHATWOOT_HMAC_TOKEN, user.id),
        name: user.name,
        email: user.email,
        orgId: session.session.activeOrganizationId ?? null,
      };
    },
  );
};
