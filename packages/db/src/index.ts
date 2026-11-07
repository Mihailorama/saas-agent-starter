import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export * from './schema.ts';
export { schema };

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  return { db: drizzle({ client: pool, schema }), pool };
}

/**
 * Runs `fn` in a transaction scoped to one tenant. Postgres RLS policies read
 * `app.org_id`, so every query inside only sees and writes rows of `orgId`.
 * This is the ONLY way application code should touch tenant tables.
 */
export function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Role whose RLS policy `operator_read` (packages/db/src/migrate.ts) sees every tenant's rows,
 * and which holds SELECT only. The app role is a member without inheriting it, so nothing changes
 * unless a transaction switches to it.
 */
export const OPERATOR_READ_ROLE = 'app_operator_read';

/**
 * Read-only transaction across all tenants, for the operator console (docs/admin.md). The ONLY
 * place that leaves tenant scoping: `apps/api/src/routes/admin-*.ts` call it behind
 * requireOperator, and a test fails if anything else does. Writes inside fail (no privilege);
 * operator changes go through `withOrg` for the one organization they concern.
 */
export function withOperatorRead<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql.raw(`set local role ${OPERATOR_READ_ROLE}`));
    return fn(tx);
  });
}
