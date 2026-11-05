import { createDb } from '@app/db';
import { sql } from 'drizzle-orm';
import { env } from './env.ts';

export const { db, pool } = createDb(env.DATABASE_URL);

/** Refuse to start if the DB role could bypass RLS (e.g. someone used the superuser URL). */
export async function assertRlsEnforced() {
  const { rows } = await db.execute<{ bypass: boolean }>(
    sql`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`,
  );
  if (rows[0]?.bypass !== false) {
    throw new Error('DATABASE_URL role bypasses RLS; use the restricted app role');
  }
}
