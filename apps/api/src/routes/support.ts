import { createHmac, timingSafeEqual } from 'node:crypto';
import { telegramSupportLinks } from '@app/db';
import { fromNodeHeaders } from 'better-auth/node';
import { lt } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { db } from '../db.ts';
import { env } from '../env.ts';
import { isEnabled } from '../flags.ts';
import { putJson } from '../s3.ts';
import {
  queueTelegramUpdate,
  startCrmSync,
  startSupportIssueClosed,
  startSupportTriage,
  type TelegramUpdate,
} from '../temporal.ts';
import { RedactionUnavailable, redact } from './hooks.ts';

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
/** scripts/released.py comments `Released in vX.Y.Z (via #PR). ...` on GitHub or Plane items. */
const RELEASED = /^Released in (v[\w.+-]{1,40}) /;
/**
 * Plane webhooks: v2 (Plane Cloud and commercial editions: `version`, dot-notation `event`,
 * `event_id`, `previous_attributes`) and v1 (the open-source Community Edition: `event` =
 * `issue` | `issue_comment`, `action`, `activity.field`; no event id).
 */
const PlaneEvent = z.object({
  version: z.string().optional(),
  event: z.string().optional(),
  action: z.string().optional(),
  entity_type: z.string().optional(),
  event_id: z.string().optional(),
  data: z
    .object({
      id: z.string().optional(),
      project_id: z.string().optional(),
      project: z.string().optional(), // v1
      issue: z.string().optional(), // v1 comment: the work item
      updated_at: z.string().optional(),
      comment_stripped: z.string().optional(), // v1 comment
      comment: z // v2
        .object({ comment_stripped: z.string().default(''), actor_id: z.string().nullish() })
        .optional(),
    })
    .default({}),
  activity: z // v1
    .object({ field: z.string().nullish(), actor: z.object({ id: z.string() }).nullish() })
    .nullish(),
  previous_attributes: z.record(z.string(), z.unknown()).default({}),
});
/**
 * Lite Telegram support (docs/support.md "Lite: Telegram only"). Both keys come from the bot
 * token, so there is one secret to set; the worker derives the same ones (worker/telegram.py).
 */
export const telegramKey = (botToken: string, purpose: 'webhook' | 'link') =>
  hmacHex(botToken, `telegram-support-${purpose}`);
const LINK_SECONDS = 600;
const linkSig = (botToken: string, exp: string, userId: string) =>
  createHmac('sha256', telegramKey(botToken, 'link'))
    .update(`${exp}.${userId}`)
    .digest('base64url')
    .slice(0, 16);
/** `/start` payload of the Help menu's deep link: `<expiry base36>_<signature>_<user id>`. */
export function telegramStartToken(botToken: string, userId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000 + LINK_SECONDS).toString(36);
  return `${exp}_${linkSig(botToken, exp, userId)}_${userId}`; // at most 64 characters
}
/** The app user of a valid payload, once: its signature is then stored as used. */
export async function telegramStartUser(botToken: string, payload: string, now = Date.now()) {
  const [, exp = '', sig = '', userId = ''] =
    payload.match(/^([0-9a-z]{1,12})_([\w-]{16})_([\w-]{1,40})$/) ?? [];
  if (!userId || Number.parseInt(exp, 36) * 1000 < now) return undefined;
  if (!sameString(sig, linkSig(botToken, exp, userId))) return undefined;
  const spent = new Date(now - 2 * LINK_SECONDS * 1000); // expired anyway: no longer needed
  await db.delete(telegramSupportLinks).where(lt(telegramSupportLinks.usedAt, spent));
  const used = await db
    .insert(telegramSupportLinks)
    .values({ signature: sig })
    .onConflictDoNothing()
    .returning();
  return used.length ? userId : undefined;
}
const TelegramMessage = z.looseObject({
  message_id: z.number().int(),
  message_thread_id: z.number().int().optional(),
  is_topic_message: z.boolean().optional(),
  chat: z.object({ id: z.number().int(), type: z.string() }),
  from: z
    .object({ id: z.number().int(), is_bot: z.boolean(), language_code: z.string().optional() })
    .optional(),
  text: z.string().optional(),
});
const TelegramBody = z.object({ update_id: z.number().int(), message: TelegramMessage.optional() });
// Service messages in a topic (the team closing it, say) cannot be copied to the user.
const SERVICE = [
  'forum_topic_closed',
  'forum_topic_reopened',
  'forum_topic_edited',
  'pinned_message',
];
const COMMAND = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i;

const Result = z.object({
  action: z.enum(['ignored', 'started', 'duplicate', 'queued', 'limited']),
});
const ErrorBody = z.object({ error: z.string() });
export const hookResponses = { 200: Result, 401: ErrorBody };
const telegramResponses = { ...hookResponses, 404: ErrorBody, 503: ErrorBody };

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
  // Per Telegram user, answered with 200: an error status makes Telegram redeliver the update.
  const perTelegramUser = app.createRateLimit({
    max: 5,
    timeWindow: '1 minute',
    keyGenerator: (req) => `tg:${(req.body as z.infer<typeof TelegramBody>).message?.from?.id}`,
  });

  app.post(
    '/telegram',
    {
      // All updates come from Telegram's few addresses; the per-user limit below does the work.
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
      schema: { hide: true, body: TelegramBody, response: telegramResponses },
    },
    async (req, reply) => {
      const token = env.TELEGRAM_SUPPORT_BOT_TOKEN;
      const group = env.TELEGRAM_SUPPORT_CHAT_ID;
      // One switch for the bot: the worker registers the webhook only while the flag is on.
      if (!token || !group || !(await isEnabled('telegram-support', { userId: 'telegram' }))) {
        return reply.code(404).send({ error: 'telegram support is off' });
      }
      const secret = header(req.headers['x-telegram-bot-api-secret-token']);
      if (!sameString(secret, telegramKey(token, 'webhook'))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const m = req.body.message; // edited messages, reactions etc. are not subscribed to
      if (!m?.from || m.from.is_bot) return { action: 'ignored' as const };
      const [, cmd = '', rest = ''] = m.text?.match(COMMAND) ?? [];
      const u: TelegramUpdate = {
        chatId: m.chat.id,
        messageId: m.message_id,
        fromId: m.from.id,
        lang: m.from.language_code?.slice(0, 8) ?? '',
      };
      if (String(m.chat.id) === group) {
        // The team, inside a user's topic: a reply to relay, or a command.
        if (!m.is_topic_message || !m.message_thread_id || SERVICE.some((k) => k in m)) {
          return { action: 'ignored' as const };
        }
        u.threadId = m.message_thread_id;
        const command = cmd.toLowerCase();
        if (command === 'bug' || command === 'feature') {
          u.command = command;
          let title: string | undefined;
          try {
            [title] = await redact([rest.trim().slice(0, 120)]);
          } catch (err) {
            if (!(err instanceof RedactionUnavailable)) throw err;
            return reply.code(503).send({ error: 'pii redaction unavailable' });
          }
          // Text goes to S3, its key to the workflow (the tracker inbox prefix: purged daily).
          u.s3Key = `tracker-inbox/telegram-${m.chat.id}-${m.message_id}.json`;
          await putJson(u.s3Key, { title });
        } else if (command) u.command = 'other';
      } else if (m.chat.type === 'private') {
        const limit = await perTelegramUser(req);
        if (!limit.isAllowed && limit.isExceeded) return { action: 'limited' as const };
        if (cmd.toLowerCase() === 'start') {
          u.command = 'start';
          // Checked here, so only the resulting id reaches Temporal, never the payload.
          if (rest) {
            u.userId = await telegramStartUser(token, rest.trim());
            u.linkFailed = !u.userId;
          }
        }
      } else {
        return { action: 'ignored' as const };
      }
      await queueTelegramUpdate(u);
      req.log.info({ chatId: u.chatId, messageId: u.messageId }, 'telegram hook');
      return { action: 'queued' as const };
    },
  );

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
      const { version, event, action, entity_type, event_id, data } = req.body;
      const v1 = !version && !event_id;
      // The release comment (scripts/released.py) means the fix is live. A v2 comment payload
      // carries no project id; the worker reads the item in its own project and ignores others.
      const comment =
        (v1
          ? event === 'issue_comment' && action === 'created' && data.comment_stripped
          : event === 'workitem.comment.created' && data.comment?.comment_stripped) || '';
      const release = comment.match(RELEASED)?.[1];
      // Otherwise a state change on a work item of our project; the worker checks the state group.
      const stateChanged = v1
        ? event === 'issue' && action === 'updated' && req.body.activity?.field === 'state_id'
        : entity_type === 'issue' && 'state_id' in req.body.previous_attributes;
      const project = data.project_id ?? data.project;
      const ours = !env.PLANE_PROJECT_ID || project === env.PLANE_PROJECT_ID;
      const issueId = v1 && event === 'issue_comment' ? data.issue : data.id;
      // v1 has no event id: one close per item update time.
      const closeId = release ? `release-${release}` : (event_id ?? data.updated_at);
      if (!(release || (stateChanged && ours)) || !issueId || !closeId) {
        return { action: 'ignored' as const };
      }
      // Author of the release comment: the worker acts only on its own token's comments.
      const author = (v1 ? req.body.activity?.actor?.id : data.comment?.actor_id) ?? '';
      const e = { tracker: 'plane' as const, issueId, release: release || '', author };
      const started = await startSupportIssueClosed(e, closeId);
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

  /** GET /api/support/telegram: the signed `/start` payload for the Help menu's Telegram link. */
  app.get(
    '/telegram',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        response: {
          200: z.object({ start: z.string() }),
          401: ErrorBody,
          403: ErrorBody,
          404: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return reply.code(401).send({ error: 'unauthorized' });
      if (session.session.impersonatedBy) return reply.code(403).send({ error: 'forbidden' });
      const token = env.TELEGRAM_SUPPORT_BOT_TOKEN;
      const on = await isEnabled('telegram-support', { userId: 'telegram' });
      // Ids longer than 40 characters do not fit the 64-character start parameter.
      if (!token || !env.TELEGRAM_SUPPORT_CHAT_ID || !on || session.user.id.length > 40) {
        return reply.code(404).send({ error: 'telegram support is off' });
      }
      return { start: telegramStartToken(token, session.user.id) };
    },
  );
};
