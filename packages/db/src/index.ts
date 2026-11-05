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
