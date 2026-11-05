import { sql } from 'drizzle-orm';
import { index, integer, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    /** SimHash of the name, filled asynchronously by the Python worker (Temporal). */
    fingerprint: text('fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId), tenantIsolation()],
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
