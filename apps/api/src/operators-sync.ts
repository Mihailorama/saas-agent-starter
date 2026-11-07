// `pnpm --filter api operators:sync`: applies OPERATOR_EMAILS to the accounts now, without an API
// restart (the API also does it at start). docs/admin.md "Bootstrap".
import { pool } from './db.ts';
import { syncOperators } from './operator-guard.ts';

const { promoted, demoted } = await syncOperators();
await pool.end();
console.log(`operators: ${promoted} promoted, ${demoted} demoted`);
