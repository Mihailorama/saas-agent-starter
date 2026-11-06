// Applies migrations as the schema owner, then (re)creates the restricted app
// role from DATABASE_URL. The app role is not superuser and has no BYPASSRLS,
// so Row-Level Security is enforced for every query the API makes.
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './index.ts';

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) throw new Error('MIGRATION_DATABASE_URL and DATABASE_URL are required');

const app = new URL(appUrl);
const role = decodeURIComponent(app.username);
const password = decodeURIComponent(app.password);
if (role === decodeURIComponent(new URL(ownerUrl).username)) {
  throw new Error('DATABASE_URL must use a different role than MIGRATION_DATABASE_URL');
}

const { db, pool } = createDb(ownerUrl);
// format() quotes identifiers/literals server-side; no string-built SQL.
const run = async (template: string, ...args: string[]) => {
  const { rows } = await pool.query<{ q: string }>(
    `select format('${template}', ${args.map((_, i) => `$${i + 1}::text`).join(', ')}) as q`,
    args,
  );
  await pool.query(rows[0]!.q);
};

const exists = await pool.query('select 1 from pg_roles where rolname = $1', [role]);
await run(
  `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L`,
  role,
  password,
);
await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
await run('GRANT USAGE ON SCHEMA public TO %I', role);
await run('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', role);
// Append-only tables: the app can add and read records, never rewrite or remove them.
for (const table of ['ai_calls', 'ai_scores']) {
  await run('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM %I', table, role);
}
await pool.end();
console.log(`migrations applied; app role "${role}" ready`);
