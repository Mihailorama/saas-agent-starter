import { buildApp } from './app.ts';
import { assertRlsEnforced, pool } from './db.ts';
import { env } from './env.ts';
import { closeFlags } from './flags.ts';
import { syncOperators } from './operator-guard.ts';
import { ensureBucket } from './s3.ts';
import { closeTemporal } from './temporal.ts';

await assertRlsEnforced();
await ensureBucket();
const operators = await syncOperators(); // OPERATOR_EMAILS -> admin plugin role (docs/admin.md)

const app = await buildApp();
app.addHook('onClose', async () => {
  await closeTemporal();
  await closeFlags();
  await pool.end();
});
await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info({ ...operators, operators: env.OPERATOR_EMAILS.length }, 'operator roles synced');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 10_000).unref();
    await app.close();
    process.exit(0);
  });
}
