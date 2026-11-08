import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../env.ts';
import { putJson } from '../s3.ts';
import { startCrmSync } from '../temporal.ts';
import { header, hmacHex, hookResponses, keepRawJson, sameString } from './support.ts';

/**
 * Booking webhooks (docs/crm.md, ADR 0026): a self-hosted Cal.diy (or Cal.com Cloud) posts here,
 * the worker writes an activity on the person in the CRM. Nothing is stored in our database.
 */

/** The prefix of booking payloads in S3_BUCKET; the worker deletes each after use, the daily
 * privacy retention whatever is left (worker/privacy.py, `purge_booking_payloads`). */
export const BOOKING_PREFIX = 'crm-bookings/';

/**
 * Cal.diy and Cal.com: `X-Cal-Signature-256: hex(HMAC-SHA256(secret, raw body))`, no prefix, no
 * timestamp (cal.diy packages/features/webhooks/lib/sendPayload.ts, `createWebhookSignature`).
 */
export const bookingSigned = (raw: Buffer, signature: string) =>
  Boolean(env.BOOKING_WEBHOOK_SECRET) &&
  sameString(signature, hmacHex(env.BOOKING_WEBHOOK_SECRET!, raw));

const TRIGGERS = ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'] as const;
const CalcomEvent = z.object({
  triggerEvent: z.string(),
  payload: z
    .object({
      uid: z.string().max(100).optional(),
      title: z.string().optional(),
      startTime: z.string().max(40).optional(),
      rescheduleUid: z.string().max(100).nullish(),
      attendees: z
        .array(z.object({ email: z.string().max(320), name: z.string().optional() }))
        .default([]),
    })
    .default({ attendees: [] }),
});

/** POST /api/hooks/calcom. Encapsulated for its raw-body JSON parser. */
export const crmHookRoutes: FastifyPluginAsyncZod = async (app) => {
  const raw = keepRawJson(app);
  app.post(
    '/calcom',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { hide: true, body: CalcomEvent, response: hookResponses },
    },
    async (req, reply) => {
      if (!bookingSigned(raw(req), header(req.headers['x-cal-signature-256']))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { triggerEvent, payload: p } = req.body;
      const trigger = TRIGGERS.find((t) => t === triggerEvent);
      const attendee = p.attendees[0];
      if (!trigger || !p.uid || !p.startTime || !attendee) return { action: 'ignored' as const };
      // No delivery id from Cal.com: trigger + booking + start time identify one change, and the
      // workflow id makes a redelivery a no-op.
      const eventId = `cal:${trigger}:${p.uid}:${p.startTime}`;
      // Attendee details never go into Temporal (ids only): the worker reads them from S3. The
      // day in the key lets retention drop leftovers without listing object dates.
      const day = new Date().toISOString().slice(0, 10);
      const bookingKey = `${BOOKING_PREFIX}${day}/${createHash('sha256').update(eventId).digest('hex')}.json`;
      await putJson(bookingKey, {
        trigger,
        uid: p.uid,
        title: (p.title ?? '').slice(0, 200),
        startTime: p.startTime,
        attendeeEmail: attendee.email,
        attendeeName: (attendee.name ?? '').slice(0, 200),
        rescheduleUid: p.rescheduleUid ?? '',
      });
      const started = await startCrmSync({ kind: 'booking', eventId, bookingKey });
      req.log.info({ trigger, started }, 'calcom hook -> crm sync');
      return { action: started ? ('started' as const) : ('duplicate' as const) };
    },
  );
};
