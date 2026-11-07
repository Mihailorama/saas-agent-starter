// Applies migrations as the schema owner, then (re)creates the restricted app
// role from DATABASE_URL. The app role is not superuser and has no BYPASSRLS,
// so Row-Level Security is enforced for every query the API makes.
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, OPERATOR_READ_ROLE } from './index.ts';

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

const roleExists = async (name: string) =>
  Boolean((await pool.query('select 1 from pg_roles where rolname = $1', [name])).rowCount);
// NOINHERIT: the app role gets the operator role's rights only after an explicit SET ROLE.
await run(
  `${(await roleExists(role)) ? 'ALTER' : 'CREATE'} ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD %L`,
  role,
  password,
);
// Operator console (docs/admin.md): a read-only role that sees every tenant's rows through the
// `operator_read` policy below. NOLOGIN; only withOperatorRead (index.ts) switches to it.
if (!(await roleExists(OPERATOR_READ_ROLE))) {
  await run('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT', OPERATOR_READ_ROLE);
}
await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
await run('GRANT USAGE ON SCHEMA public TO %I', role);
await run('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', role);
// Append-only tables: the app can add and read records, never rewrite or remove them.
for (const table of ['ai_calls']) {
  await run('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM %I', table, role);
}
await run('GRANT USAGE ON SCHEMA public TO %I', OPERATOR_READ_ROLE);
await run('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', OPERATOR_READ_ROLE);
// Membership without inheritance (PostgreSQL 16+ grant option; older servers rely on the app
// role's NOINHERIT above). The API refuses to start if it inherits it anyway (apps/api/src/db.ts).
const pg16 =
  Number((await pool.query('show server_version_num')).rows[0].server_version_num) >= 160000;
await run(`GRANT %I TO %I${pg16 ? ' WITH INHERIT FALSE, SET TRUE' : ''}`, OPERATOR_READ_ROLE, role);
// Every table with RLS (all tenant tables, including ones added later) gets the operator policy:
// SELECT for the operator role only. Tenant policies stay as they are.
const { rows: rlsTables } = await pool.query<{ t: string }>(
  `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'operator_read')`,
);
for (const { t } of rlsTables) {
  await run(
    'CREATE POLICY operator_read ON %I FOR SELECT TO %I USING (true)',
    t,
    OPERATOR_READ_ROLE,
  );
}
await pool.end();
console.log(`migrations applied; app role "${role}" ready`);
