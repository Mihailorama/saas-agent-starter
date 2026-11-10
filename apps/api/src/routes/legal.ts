import { user } from '@app/db';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { db } from '../db.ts';
import { pickLocale } from '../email.ts';
import { hasAccepted, LEGAL, verifyUnsubscribe } from '../legal.ts';
import { READ_ONLY } from '../operator-guard.ts';
import { bearerToken, httpError } from '../tenant.ts';

// Terms/privacy acceptance, age self-attestation and marketing consent (docs/legal.md). Session
// only, no organization needed; tenant routes refuse users who have not accepted (tenant.ts).

const Status = z.object({
  terms: z.string(),
  privacy: z.string(),
  /** Minimum age to confirm at sign-up; null when the product is B2B-only (no question). */
  minAge: z.number().int().nullable(),
  /** True until the user accepts the current terms and privacy versions. */
  required: z.boolean(),
  /** True when the user never accepted any version (sign-up, not a re-acceptance). */
  firstTime: z.boolean(),
  /** An operator viewing as the user (docs/admin.md): the user decides, not the operator. */
  viewOnly: z.boolean(),
  marketingOptIn: z.boolean(),
});
const Err = z.object({ error: z.string() });

async function sessionOf(req: FastifyRequest, reply: FastifyReply) {
  if (bearerToken(req)) {
    await reply.code(403).send({ error: 'API keys are not accepted here' });
    return;
  }
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) await reply.code(401).send({ error: 'unauthorized' });
  return session ?? undefined;
}

async function status(userId: string, viewOnly: boolean) {
  const [u] = await db
    .select({
      termsVersion: user.termsVersion,
      privacyVersion: user.privacyVersion,
      marketingOptIn: user.marketingOptIn,
    })
    .from(user)
    .where(eq(user.id, userId));
  if (!u) throw httpError(401, 'unauthorized');
  return {
    terms: LEGAL.terms,
    privacy: LEGAL.privacy,
    minAge: LEGAL.b2bOnly ? null : LEGAL.minAge,
    // An operator's view is read-only and never blocked by the user's pending acceptance.
    required: !viewOnly && !hasAccepted(u),
    firstTime: u.termsVersion === null,
    viewOnly,
    marketingOptIn: u.marketingOptIn,
  };
}

export const legalRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    { schema: { tags: ['legal'], response: { 200: Status, 401: Err, 403: Err } } },
    async (req, reply) => {
      const session = await sessionOf(req, reply);
      if (!session) return reply;
      return status(session.user.id, Boolean(session.session.impersonatedBy));
    },
  );

  app.post(
    '/accept',
    {
      schema: {
        tags: ['legal'],
        body: z.object({
          /** The versions the user was shown; refused (409) when they are no longer current. */
          terms: z.string(),
          privacy: z.string(),
          ageConfirmed: z.boolean().default(false),
          /** Sign-up only: the optional marketing opt-in, unticked by default. */
          marketingOptIn: z.boolean().optional(),
        }),
        response: { 200: Status, 400: Err, 401: Err, 403: Err, 409: Err },
      },
    },
    async (req, reply) => {
      const session = await sessionOf(req, reply);
      if (!session) return reply;
      if (session.session.impersonatedBy) return reply.code(403).send({ error: READ_ONLY });
      const b = req.body;
      if (b.terms !== LEGAL.terms || b.privacy !== LEGAL.privacy) {
        return reply.code(409).send({
          error: 'These documents changed. Review the current versions and accept again.',
        });
      }
      if (!LEGAL.b2bOnly && !b.ageConfirmed) {
        return reply
          .code(400)
          .send({ error: `Confirm that you are at least ${LEGAL.minAge} years old.` });
      }
      const now = new Date();
      await db
        .update(user)
        .set({
          termsVersion: b.terms,
          privacyVersion: b.privacy,
          legalAcceptedAt: now,
          locale: pickLocale(req.headers['accept-language']),
          ...(!LEGAL.b2bOnly && { ageConfirmedAt: now }),
          ...(b.marketingOptIn !== undefined && {
            marketingOptIn: b.marketingOptIn,
            marketingOptInAt: now,
          }),
        })
        .where(eq(user.id, session.user.id));
      req.log.info(
        { userId: session.user.id, terms: b.terms, privacy: b.privacy },
        'legal accepted',
      );
      return status(session.user.id, false);
    },
  );

  app.put(
    '/marketing',
    {
      schema: {
        tags: ['legal'],
        body: z.object({ optIn: z.boolean() }),
        response: { 200: Status, 401: Err, 403: Err },
      },
    },
    async (req, reply) => {
      const session = await sessionOf(req, reply);
      if (!session) return reply;
      if (session.session.impersonatedBy) return reply.code(403).send({ error: READ_ONLY });
      await db
        .update(user)
        .set({ marketingOptIn: req.body.optIn, marketingOptInAt: new Date() })
        .where(eq(user.id, session.user.id));
      return status(session.user.id, false);
    },
  );
};

/**
 * One-click unsubscribe (RFC 8058): the List-Unsubscribe header's URL takes a POST with the body
 * `List-Unsubscribe=One-Click`; the web's /unsubscribe page (the link in the mail) posts the same
 * token as JSON. No sign-in: the token is the authority, and it can only opt out.
 */
export const unsubscribeRoutes: FastifyPluginAsyncZod = async (app) => {
  // Mail clients post a form; its fields carry nothing we need (the token is in the URL).
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data']) {
    app.addContentTypeParser(type, { parseAs: 'string' }, (_req, _body, done) => done(null, {}));
  }
  app.post(
    '/',
    {
      // Per token, not per IP: one-click POSTs come from the mail providers' shared addresses.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) =>
            `unsubscribe:${(req.query as { token?: string }).token ?? req.ip}`,
        },
      },
      schema: {
        tags: ['legal'],
        querystring: z.object({ token: z.string().max(200).optional() }),
        body: z.object({ token: z.string().max(200).optional() }).optional(),
        response: { 200: z.object({ unsubscribed: z.literal(true) }), 400: Err },
      },
    },
    async (req, reply) => {
      const userId = verifyUnsubscribe(req.query.token ?? req.body?.token ?? '');
      if (!userId) return reply.code(400).send({ error: 'This unsubscribe link is not valid.' });
      await db
        .update(user)
        .set({ marketingOptIn: false, marketingOptInAt: new Date() })
        .where(and(eq(user.id, userId), eq(user.marketingOptIn, true)));
      req.log.info({ userId }, 'marketing unsubscribed');
      return { unsubscribed: true as const };
    },
  );
};
