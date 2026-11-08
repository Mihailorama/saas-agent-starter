import { auditLog, organization, rewardGrants, withOperatorRead, withOrg } from '@app/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../db.ts';
import { httpError } from '../tenant.ts';
import { audit, ErrorBody, iso, Reason, requireOperator } from './admin-common.ts';

/** `operator.reward.applied` rows resolve pending_manual grants (reward_grants is append-only). */
const RESOLVED = 'operator.reward.applied';
const unresolved = sql`not exists (select 1 from ${auditLog} where ${auditLog.action} = ${RESOLVED}
  and ${auditLog.target} = ${rewardGrants.id}::text)`;

/**
 * Rewards the billing provider could not apply (manual contracts, no API link, provider errors;
 * docs/growth.md). Operators apply each one by hand (credit note, invoice line) and mark it.
 */
export const adminRewardRoutes: FastifyPluginAsyncZod = async (app) => {
  const op = { preHandler: requireOperator, schema: { tags: ['admin'], hide: true } };
  app.get(
    '/rewards/pending',
    {
      ...op,
      schema: {
        ...op.schema,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              orgId: z.string(),
              orgName: z.string(),
              ruleId: z.string(),
              reward: z.record(z.string(), z.unknown()),
              createdAt: z.string(),
            }),
          ),
        },
      },
    },
    async () => {
      // Inside withOperatorRead nothing is scoped by RLS: every org's pending grants.
      const rows = await withOperatorRead(db, (tx) =>
        tx
          .select({
            id: rewardGrants.id,
            orgId: rewardGrants.orgId,
            orgName: organization.name,
            ruleId: rewardGrants.ruleId,
            reward: rewardGrants.reward,
            createdAt: rewardGrants.createdAt,
          })
          .from(rewardGrants)
          .innerJoin(organization, eq(organization.id, rewardGrants.orgId))
          .where(and(eq(rewardGrants.status, 'pending_manual'), unresolved))
          .orderBy(desc(rewardGrants.createdAt))
          .limit(200),
      );
      return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt)! }));
    },
  );

  app.post(
    '/rewards/:id/applied',
    {
      ...op,
      schema: {
        ...op.schema,
        params: z.object({ id: z.uuid() }),
        body: z.object({ orgId: z.string().min(1).max(100), reason: Reason }),
        response: { 204: z.null(), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const { orgId, reason } = req.body;
      await withOrg(db, orgId, async (tx) => {
        const [g] = await tx
          .select({ id: rewardGrants.id })
          .from(rewardGrants)
          .where(
            and(
              eq(rewardGrants.id, req.params.id),
              eq(rewardGrants.status, 'pending_manual'),
              unresolved,
            ),
          );
        if (!g) throw httpError(404, 'not found');
        await audit(tx, req, orgId, 'reward.applied', g.id, reason);
      });
      return reply.code(204).send(null);
    },
  );
};
