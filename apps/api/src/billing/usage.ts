import { usageCounters, withOrg } from '@app/db';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db.ts';
import { isEnabled } from '../flags.ts';

/**
 * Counts one API-key request for the `api_calls` meter (docs/billing.md "Usage-based"): one row
 * per org and hour, which the worker reports to the provider once the hour has closed. Never
 * fails the request.
 * ponytail: one upsert per request, contended for a very busy org; move the counter to Redis if
 * that shows up.
 */
export async function countApiCall(orgId: string, log: FastifyBaseLogger) {
  try {
    // Evaluated per org (the org is the flag's subject), as the worker does when reporting.
    if (!(await isEnabled('billing-usage', { userId: orgId, orgId }))) return;
    await withOrg(db, orgId, (tx) =>
      tx
        .insert(usageCounters)
        .values({ orgId, meter: 'api_calls', hour: sql`date_trunc('hour', now())`, count: 1 })
        .onConflictDoUpdate({
          target: [usageCounters.orgId, usageCounters.meter, usageCounters.hour],
          set: { count: sql`${usageCounters.count} + 1` },
        }),
    );
  } catch (err) {
    log.error({ err, orgId }, 'counting an API call failed');
  }
}
