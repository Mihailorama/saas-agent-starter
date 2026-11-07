import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
    /** Content objects are deleted after this by the daily retention schedule (docs/privacy.md). */
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
    // Without org_id first, so org-wide queries (spend sums) keep (org_id, created_at).
    index().on(t.contentExpiresAt),
    index().on(t.actorId),
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
    /** Uploader: their data export includes the file; erasing them only clears this (org data). */
    createdBy: text('created_by'),
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
 * The organization's current plan, as domain data (docs/billing.md, ADR 0019). One row per org,
 * created at first checkout; no row means the default plan. Written by the worker from
 * normalized provider events. Invoices and payment history stay in the provider: this is not a
 * payments ledger.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    orgId: orgId().primaryKey(),
    planId: text('plan_id').notNull(),
    status: text('status', { enum: ['incomplete', 'active', 'past_due', 'canceled'] }).notNull(),
    /** Billing contour (config/plans.json `contours`): picks the provider and currencies. */
    contour: text('contour').notNull(),
    provider: text('provider').notNull(),
    currency: text('currency').notNull(),
    /** Provider references (e.g. Stripe customer and subscription ids). */
    customerId: text('customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** Admin-raised LLM spend limits per currency, capped by the plan's llmSpendMax. */
    llmSpendLimits: jsonb('llm_spend_limits').$type<Record<string, number>>(),
    /** Time of the newest provider event applied; older (replayed) events are ignored. */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'subscriptions_status',
      sql`${t.status} in ('incomplete', 'active', 'past_due', 'canceled')`,
    ),
    tenantIsolation(),
  ],
);

/**
 * Outbound webhooks (docs/public-api.md). A customer endpoint subscribes to event types. The
 * signing secret (Standard Webhooks `whsec_...`) is stored encrypted (`v1:<key id>:<iv>:<data>`,
 * AES-256-GCM, WEBHOOK_ENCRYPTION_KEYS); only the worker decrypts it to sign. After a rotation the
 * previous secret keeps signing until `previous_secret_expires_at`. The worker disables an
 * endpoint on 410 Gone or after WEBHOOK_DISABLE_AFTER_FAILURES failed deliveries in a row.
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
    /** Why it is disabled: manual, gone (410), failures (too many failed deliveries). */
    disabledReason: text('disabled_reason', { enum: ['manual', 'gone', 'failures'] }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    /** Failed deliveries since the last successful one. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    secret: text('secret').notNull(),
    previousSecret: text('previous_secret'),
    previousSecretExpiresAt: timestamp('previous_secret_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orgId),
    check(
      'webhook_endpoints_disabled_reason',
      sql`${t.disabledReason} in ('manual', 'gone', 'failures')`,
    ),
    tenantIsolation(),
  ],
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

/**
 * Data-subject requests (docs/privacy.md): export or deletion of a user or an organization. Not
 * tenant-scoped: a user's request spans organizations, and the row outlives a deleted subject as
 * the audit record of what was done. No foreign keys and no personal data, only ids; progress
 * lives in the Temporal workflow history, the outcome in `status` and `report`.
 */
export const privacyRequests = pgTable(
  'privacy_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: ['export', 'deletion'] }).notNull(),
    subjectType: text('subject_type', { enum: ['user', 'org'] }).notNull(),
    /** User id or organization id. */
    subjectId: text('subject_id').notNull(),
    /** User who asked (the subject itself, or an owner of the organization). */
    requestedBy: text('requested_by').notNull(),
    status: text('status', {
      enum: ['scheduled', 'running', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    /** Deletion: end of the grace period (cancellable until then). Export: request time. */
    executeAfter: timestamp('execute_after', { withTimezone: true }).notNull().defaultNow(),
    /** Export: key of the ZIP in S3_BUCKET; cleared when it expires. */
    resultKey: text('result_key'),
    /**
     * Export: the ZIP is deleted after this. Organization deletion: the retained records (ai_calls,
     * audit_log, the anonymised organization row) are purged after this.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Per-step outcome: what was exported/deleted where, what could not be and why. */
    report: jsonb('report'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index().on(t.subjectType, t.subjectId, t.createdAt),
    // One open deletion per subject: a second request while one is pending is refused.
    uniqueIndex('privacy_requests_open_deletion')
      .on(t.subjectType, t.subjectId)
      .where(sql`${t.kind} = 'deletion' and ${t.status} in ('scheduled', 'running')`),
    check('privacy_requests_kind', sql`${t.kind} in ('export', 'deletion')`),
    check('privacy_requests_subject_type', sql`${t.subjectType} in ('user', 'org')`),
    check(
      'privacy_requests_status',
      sql`${t.status} in ('scheduled', 'running', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);
