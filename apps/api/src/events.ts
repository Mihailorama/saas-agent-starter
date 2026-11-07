import { randomUUID } from 'node:crypto';
import { type Tx, webhookDeliveries, webhookEndpoints, webhookEvents } from '@app/db';
import { and, arrayContains, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import catalog from '../../../config/webhook-events.json' with { type: 'json' };
import { env } from './env.ts';
import { startWebhookEvent, type WebhookEvent } from './temporal.ts';

/** Outbound webhook event types (config/webhook-events.json). */
export type EventType = keyof typeof catalog.events;
export const eventCatalog = catalog.events;
export const eventTypes = Object.keys(catalog.events) as EventType[];

declare module 'fastify' {
  interface FastifyRequest {
    /** Events published in the current tenant transaction, started after it commits. */
    webhookEvents?: WebhookEvent[];
  }
}

/**
 * The one path for domain events. Call it inside `withTenant`, in the same transaction as the
 * change: the event and one delivery per subscribed endpoint commit (or roll back) with it, and
 * `withTenant` starts the delivery workflow after the commit. Body (Standard Webhooks style):
 * `{ type, timestamp, data }`; it is stored as sent, so a replay sends the same bytes.
 */
export async function publishEvent(req: FastifyRequest, tx: Tx, type: EventType, data: object) {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.enabled, true), arrayContains(webhookEndpoints.eventTypes, [type])),
    );
  if (!endpoints.length) return;
  const payload = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  // Payloads are our DTOs with bounded fields: exceeding the cap is a bug, fail loudly.
  if (Buffer.byteLength(payload) > env.WEBHOOK_MAX_PAYLOAD_BYTES) {
    throw new Error(`webhook payload for ${type} exceeds WEBHOOK_MAX_PAYLOAD_BYTES`);
  }
  const { orgId } = req.tenant;
  const eventId = randomUUID();
  await tx.insert(webhookEvents).values({ id: eventId, orgId, type, payload });
  const deliveries = await tx
    .insert(webhookDeliveries)
    .values(endpoints.map((e) => ({ orgId, eventId, endpointId: e.id })))
    .returning({ id: webhookDeliveries.id });
  req.webhookEvents = [
    ...(req.webhookEvents ?? []),
    { orgId, eventId, deliveryIds: deliveries.map((d) => d.id) },
  ];
}

/** Starts delivery of the events published by this request (after their transaction committed). */
export async function flushEvents(req: FastifyRequest) {
  const events = req.webhookEvents ?? [];
  req.webhookEvents = [];
  for (const event of events) {
    // ponytail: lost if Temporal is down at this instant (deliveries stay pending); the
    // transactional outbox in docs/TODO.md would cover it.
    await startWebhookEvent(event, `webhook-event-${event.eventId}`).catch((err) =>
      req.log.error({ err, eventId: event.eventId }, 'failed to start WebhookEventWorkflow'),
    );
  }
}
