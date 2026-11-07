import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../env.ts';
import { startCrmSync } from '../temporal.ts';
import { header, hmacHex, hookResponses, keepRawJson, sameString } from './support.ts';

/**
 * Booking webhooks (docs/crm.md, ADR 0026): Cal.com Cloud or a self-hosted Cal.diy posts here, the
 * worker writes an activity on the person in the CRM. Nothing is stored in our database.
 */

/** Cal.com: `X-Cal-Signature-256: hex(HMAC-SHA256(secret, raw body))`, no prefix, no timestamp. */
export const calcomSigned = (raw: Buffer, signature: string) =>
  Boolean(env.CALCOM_WEBHOOK_SECRET) &&
  sameString(signature, hmacHex(env.CALCOM_WEBHOOK_SECRET!, raw));

const TRIGGERS = ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'] as const;
const CalcomEvent = z.object({
  triggerEvent: z.string(),
  payload: z
    .object({
      uid: z.string().max(100).optional(),
      title: z.string().optional(),
      startTime: z.string().max(40).optional(),
      rescheduleUid: z.string().max(100).nullish(),
      attendees: z.array(z.object({ email: z.string(), name: z.string().optional() })).default([]),
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
      if (!calcomSigned(raw(req), header(req.headers['x-cal-signature-256']))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { triggerEvent, payload: p } = req.body;
      const trigger = TRIGGERS.find((t) => t === triggerEvent);
      const attendee = p.attendees[0];
      if (!trigger || !p.uid || !p.startTime || !attendee) return { action: 'ignored' as const };
      // No delivery id from Cal.com: trigger + booking + start time identify one change, and the
      // workflow id makes a redelivery a no-op.
      const started = await startCrmSync({
        kind: 'booking',
        eventId: `cal:${trigger}:${p.uid}:${p.startTime}`,
        booking: {
          trigger,
          uid: p.uid,
          title: (p.title ?? '').slice(0, 200),
          startTime: p.startTime,
          attendeeEmail: attendee.email,
          attendeeName: (attendee.name ?? '').slice(0, 200),
          rescheduleUid: p.rescheduleUid ?? '',
        },
      });
      req.log.info({ trigger, started }, 'calcom hook -> crm sync');
      return { action: started ? ('started' as const) : ('duplicate' as const) };
    },
  );
};
