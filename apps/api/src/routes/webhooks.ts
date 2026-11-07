import { randomBytes } from 'node:crypto';
import {
  type Tx,
  webhookAttempts,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
} from '@app/db';
import { and, asc, count, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eventCatalog, eventTypes } from '../events.ts';
import { startWebhookEvent } from '../temporal.ts';
import { access, httpError, withTenant } from '../tenant.ts';

/**
 * Outbound webhooks (docs/public-api.md): endpoints subscribe to event types; deliveries and
 * their attempts are written by the worker (worker/webhooks.py). Org admins, or API keys with
 * webhooks:read / webhooks:write.
 */
const Endpoint = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
});
const url = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((u) => {
    const parsed = new URL(u);
    return !parsed.username && !parsed.password;
  }, 'credentials in the URL are not allowed');
const EndpointInput = z.object({
  url,
  description: z.string().trim().max(500).optional(),
  eventTypes: z.array(z.enum(eventTypes)).min(1),
  enabled: z.boolean().optional(),
});
const Secret = z.object({ secret: z.string() });
const Delivery = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  eventType: z.string(),
  endpointId: z.uuid(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  attempts: z.number().int(),
  lastStatusCode: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const Attempt = z.object({
  attempt: z.number().int(),
  statusCode: z.number().int().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
  createdAt: z.string(),
});
const Id = z.object({ id: z.uuid() });
const DeliveryQuery = z.object({
  endpointId: z.uuid().optional(),
  status: z.enum(['pending', 'succeeded', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const ErrorBody = z.object({ error: z.string() });

/** Standard Webhooks secret: `whsec_` + base64 of 24 random bytes. */
const newSecret = () => `whsec_${randomBytes(24).toString('base64')}`;
/** After a rotation the old secret keeps signing (second signature) for this long. */
const ROTATION_OVERLAP_MS = 24 * 3600_000;

const endpointDto = ({
  orgId: _,
  secret: __,
  previousSecret: ___,
  previousSecretExpiresAt: ____,
  createdAt,
  ...e
}: typeof webhookEndpoints.$inferSelect) => ({ ...e, createdAt: createdAt.toISOString() });

const attemptCount = sql<number>`(select count(*)::int from ${webhookAttempts} where ${webhookAttempts.deliveryId} = ${webhookDeliveries.id})`;
const lastStatusCode = sql<
  number | null
>`(select ${webhookAttempts.statusCode} from ${webhookAttempts} where ${webhookAttempts.deliveryId} = ${webhookDeliveries.id} order by ${webhookAttempts.attempt} desc limit 1)`;
const selectDeliveries = (tx: Tx, where?: SQL) =>
  tx
    .select({
      id: webhookDeliveries.id,
      eventId: webhookDeliveries.eventId,
      eventType: webhookEvents.type,
      endpointId: webhookDeliveries.endpointId,
      status: webhookDeliveries.status,
      attempts: attemptCount,
      lastStatusCode,
      createdAt: webhookDeliveries.createdAt,
      updatedAt: webhookDeliveries.updatedAt,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.eventId))
    .where(where);
const deliveryDto = <T extends { createdAt: Date; updatedAt: Date }>(d: T) => ({
  ...d,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});

export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = access('webhooks:read');
  const write = access('webhooks:write');
  const tags = ['webhooks'];

  app.get(
    '/event-types',
    {
      ...read,
      schema: {
        tags,
        response: { 200: z.array(z.object({ type: z.string(), description: z.string() })) },
      },
    },
    async () => eventTypes.map((type) => ({ type, description: eventCatalog[type].description })),
  );

  app.get(
    '/endpoints',
    { ...read, schema: { tags, response: { 200: z.array(Endpoint) } } },
    async (req) =>
      withTenant(req, async (tx) =>
        (await tx.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt))).map(
          endpointDto,
        ),
      ),
  );

  app.post(
    '/endpoints',
    {
      ...write,
      schema: {
        tags,
        body: EndpointInput,
        response: { 201: z.object({ endpoint: Endpoint, secret: z.string() }) },
      },
    },
    async (req, reply) => {
      const row = await withTenant(
        req,
        async (tx) => {
          const [created] = await tx
            .insert(webhookEndpoints)
            .values({
              orgId: req.tenant.orgId,
              url: req.body.url,
              description: req.body.description || null,
              eventTypes: [...new Set(req.body.eventTypes)],
              enabled: req.body.enabled ?? true,
              secret: newSecret(),
            })
            .returning();
          return created!;
        },
        (e) => e.id,
      );
      return reply.code(201).send({ endpoint: endpointDto(row), secret: row.secret });
    },
  );

  app.patch(
    '/endpoints/:id',
    {
      ...write,
      schema: {
        tags,
        params: Id,
        body: EndpointInput.partial(),
        response: { 200: Endpoint, 404: ErrorBody },
      },
    },
    async (req) =>
      withTenant(req, async (tx) => {
        const { url, description, eventTypes: types, enabled } = req.body;
        const [row] = await tx
          .update(webhookEndpoints)
          .set({
            ...(url !== undefined && { url }),
            ...(description !== undefined && { description: description || null }),
            ...(types !== undefined && { eventTypes: [...new Set(types)] }),
            ...(enabled !== undefined && { enabled }),
          })
          .where(eq(webhookEndpoints.id, req.params.id))
          .returning();
        if (!row) throw httpError(404, 'not found');
        return endpointDto(row);
      }),
  );

  app.delete('/endpoints/:id', { ...write, schema: { tags, params: Id } }, async (req, reply) => {
    await withTenant(req, async (tx) => {
      const [row] = await tx
        .delete(webhookEndpoints)
        .where(eq(webhookEndpoints.id, req.params.id))
        .returning({ id: webhookEndpoints.id });
      if (!row) throw httpError(404, 'not found');
    });
    return reply.code(204).send();
  });

  app.get(
    '/endpoints/:id/secret',
    { ...write, schema: { tags, params: Id, response: { 200: Secret, 404: ErrorBody } } },
    async (req) =>
      withTenant(req, async (tx) => {
        const [row] = await tx
          .select({ secret: webhookEndpoints.secret })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, req.params.id));
        if (!row) throw httpError(404, 'not found');
        return row;
      }),
  );

  // The old secret keeps signing for ROTATION_OVERLAP_MS so receivers can switch without gaps.
  app.post(
    '/endpoints/:id/rotate-secret',
    { ...write, schema: { tags, params: Id, response: { 200: Secret, 404: ErrorBody } } },
    async (req) =>
      withTenant(req, async (tx) => {
        const [row] = await tx
          .update(webhookEndpoints)
          .set({
            previousSecret: sql`${webhookEndpoints.secret}`,
            previousSecretExpiresAt: new Date(Date.now() + ROTATION_OVERLAP_MS),
            secret: newSecret(),
          })
          .where(eq(webhookEndpoints.id, req.params.id))
          .returning({ secret: webhookEndpoints.secret });
        if (!row) throw httpError(404, 'not found');
        return row;
      }),
  );

  app.get(
    '/deliveries',
    {
      ...read,
      schema: {
        tags,
        querystring: DeliveryQuery,
        response: { 200: z.object({ items: z.array(Delivery), total: z.number().int() }) },
      },
    },
    async (req) => {
      const { endpointId, status, limit, offset } = req.query;
      const where = and(
        ...([
          endpointId && eq(webhookDeliveries.endpointId, endpointId),
          status && eq(webhookDeliveries.status, status),
        ].filter(Boolean) as SQL[]),
      );
      return withTenant(req, async (tx) => {
        const rows = await selectDeliveries(tx, where)
          .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
          .limit(limit)
          .offset(offset);
        const [totals] = await tx.select({ total: count() }).from(webhookDeliveries).where(where);
        return { items: rows.map(deliveryDto), total: totals?.total ?? 0 };
      });
    },
  );

  app.get(
    '/deliveries/:id',
    {
      ...read,
      schema: {
        tags,
        params: Id,
        response: {
          200: Delivery.extend({ payload: z.unknown(), attemptLog: z.array(Attempt) }),
          404: ErrorBody,
        },
      },
    },
    async (req) =>
      withTenant(req, async (tx) => {
        const [row] = await selectDeliveries(tx, eq(webhookDeliveries.id, req.params.id));
        if (!row) throw httpError(404, 'not found');
        const [event] = await tx
          .select({ payload: webhookEvents.payload })
          .from(webhookEvents)
          .where(eq(webhookEvents.id, row.eventId));
        const attempts = await tx
          .select()
          .from(webhookAttempts)
          .where(eq(webhookAttempts.deliveryId, row.id))
          .orderBy(asc(webhookAttempts.attempt));
        return {
          ...deliveryDto(row),
          payload: JSON.parse(event!.payload),
          attemptLog: attempts.map((a) => ({
            attempt: a.attempt,
            statusCode: a.statusCode,
            error: a.error,
            durationMs: a.durationMs,
            createdAt: a.createdAt.toISOString(),
          })),
        };
      }),
  );

  // Sends the stored body again (same webhook-id, so receivers can deduplicate), whatever the
  // delivery's state. The workflow id includes the attempt count: a double click starts one.
  app.post(
    '/deliveries/:id/replay',
    {
      ...write,
      schema: {
        tags,
        params: Id,
        response: { 202: z.object({ id: z.uuid() }), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const row = await withTenant(req, async (tx) => {
        const [found] = await selectDeliveries(tx, eq(webhookDeliveries.id, req.params.id));
        if (!found) throw httpError(404, 'not found');
        return found;
      });
      await startWebhookEvent(
        { orgId: req.tenant.orgId, eventId: row.eventId, deliveryIds: [row.id], replay: true },
        `webhook-replay-${row.id}-${row.attempts}`,
      ).catch((err) => {
        req.log.error({ err, deliveryId: row.id }, 'failed to start webhook replay');
        throw httpError(503, 'delivery is unavailable, try again later');
      });
      return reply.code(202).send({ id: row.id });
    },
  );
};
