import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
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

/**
 * Quality scores of LLM calls (docs/adr/0009-llm-ops.md). Append-only like ai_calls: a new
 * judgement is a new row. `user` = human review (confirm/correct), `judge` = LLM-as-a-judge
 * (drift workflow; the judge's own call is `judge_call_id`), `rule` = deterministic check.
 * No content here: the judge's reasoning stays in that call's S3 response object.
 */
export const aiScores = pgTable(
  'ai_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    callId: uuid('call_id')
      .notNull()
      .references(() => aiCalls.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['user', 'judge', 'rule'] }).notNull(),
    name: text('name').notNull(),
    value: numeric('value', { precision: 10, scale: 4, mode: 'number' }).notNull(),
    comment: text('comment'),
    actorId: text('actor_id'),
    judgeCallId: uuid('judge_call_id').references(() => aiCalls.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orgId, t.callId),
    index().on(t.orgId, t.createdAt),
    check('ai_scores_source', sql`${t.source} in ('user', 'judge', 'rule')`),
    tenantIsolation(),
  ],
);

/**
 * Calls an admin picked for the golden eval set ("Add to golden set"). `pnpm eval:pull`
 * exports pending items to Promptfoo test cases and marks them exported.
 */
export const aiDatasetItems = pgTable(
  'ai_dataset_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgId(),
    callId: uuid('call_id')
      .notNull()
      .unique()
      .references(() => aiCalls.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    status: text('status', { enum: ['pending', 'exported'] })
      .notNull()
      .default('pending'),
    addedBy: text('added_by'),
    exportedAt: timestamp('exported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orgId, t.status),
    check('ai_dataset_items_status', sql`${t.status} in ('pending', 'exported')`),
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
