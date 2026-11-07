import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization } from './auth-schema.ts';

export * from './auth-schema.ts';

/**
 * RLS policy for tenant tables: a row is visible and writable only when its
 * org_id equals the transaction setting made by `withOrg`. No setting -> no rows.
 */
const tenantIsolation = () => {
  const sameOrg = sql`org_id = current_setting('app.org_id', true)`;
  return pgPolicy('tenant_isolation', { for: 'all', using: sameOrg, withCheck: sameOrg });
};

const orgId = () =>
  text('org_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    name: text('name').notNull(),
    description: text('description'),
    /** SimHash of the name, filled asynchronously by the Python worker (Temporal). */
    fingerprint: text('fingerprint'),
    /** AI summary of the description (worker, via ai.call_llm) and its human review state. */
    aiSummary: text('ai_summary'),
    aiStatus: text('ai_status', { enum: ['generated', 'confirmed', 'corrected'] }),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id, { onDelete: 'set null' }),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orgId),
    check('projects_ai_status', sql`${t.aiStatus} in ('generated', 'confirmed', 'corrected')`),
    tenantIsolation(),
  ],
);

/**
 * One row per LLM call, written by the worker's `ai.call_llm` gateway. Append-only: the app
 * role gets no UPDATE/DELETE on it (packages/db/src/migrate.ts). Prompt and completion
 * content live in S3 objects (keys below), never in this row or in logs/spans.
 */
export const aiCalls = pgTable(
  'ai_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    actorId: text('actor_id'),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    /** Model id we requested (checked against config/ai-models.json). */
    requestModel: text('request_model').notNull(),
    /** Exact model id the provider reported, when it reports one. */
    responseModel: text('response_model'),
    promptTemplateId: text('prompt_template_id').notNull(),
    promptTemplateVersion: text('prompt_template_version').notNull(),
    requestKey: text('request_key').notNull(),
    responseKey: text('response_key'),
    /** Content objects are expected to be gone after this (bucket lifecycle rule). */
    contentExpiresAt: timestamp('content_expires_at', { withTimezone: true }).notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    cost: numeric('cost', { precision: 14, scale: 6, mode: 'number' }),
    costCurrency: text('cost_currency'),
    latencyMs: integer('latency_ms').notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    errorClass: text('error_class'),
    traceId: text('trace_id'),
    spanId: text('span_id'),
    contour: text('contour').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orgId, t.createdAt),
    check('ai_calls_status', sql`${t.status} in ('ok', 'error')`),
    tenantIsolation(),
  ],
);

/** Files in S3. The object key is derived from ids; access is checked via this row (RLS). */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.projectId), tenantIsolation()],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    target: text('target'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.createdAt), tenantIsolation()],
);

/**
 * Outbound webhooks (docs/public-api.md). A customer endpoint subscribes to event types; the
 * signing secret (Standard Webhooks `whsec_...`) is readable by the worker, which signs every
 * attempt. After a rotation the previous secret keeps signing until `previous_secret_expires_at`.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    url: text('url').notNull(),
    description: text('description'),
    eventTypes: text('event_types').array().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    secret: text('secret').notNull(),
    previousSecret: text('previous_secret'),
    previousSecretExpiresAt: timestamp('previous_secret_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId), tenantIsolation()],
);

/** One row per published event that had at least one subscribed endpoint; `payload` is the
 * exact JSON body sent (and re-sent on replay). Written by publishEvent() in apps/api. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    type: text('type').notNull(),
    payload: text('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.createdAt), tenantIsolation()],
);

/** An event for one endpoint. The worker (WebhookEventWorkflow) moves it to succeeded/failed. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => webhookEvents.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orgId, t.createdAt),
    index().on(t.endpointId),
    unique().on(t.eventId, t.endpointId),
    check('webhook_deliveries_status', sql`${t.status} in ('pending', 'succeeded', 'failed')`),
    tenantIsolation(),
  ],
);

/** Every HTTP attempt of a delivery: what the customer sees in "delivery attempts". No bodies. */
export const webhookAttempts = pgTable(
  'webhook_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    /** HTTP status, null when no response arrived (see `error`). */
    statusCode: integer('status_code'),
    /** Short error class: timeout, connection_error, blocked_address, invalid_url, ... */
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.deliveryId), tenantIsolation()],
);
