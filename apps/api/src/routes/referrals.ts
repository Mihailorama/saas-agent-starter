import { organization, rewardGrants, user } from '@app/db';
import { count, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { referralLink } from '../billing/referrals.ts';
import { db } from '../db.ts';
import { isEnabled } from '../flags.ts';
import { httpError, requireRole, withTenant } from '../tenant.ts';

/** The org's referral link and how many referrals rewarded it (docs/growth.md). Admins. */
export const referralRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['referrals'],
        response: {
          200: z.object({
            via: z.enum(['native', 'dub']),
            link: z.string().nullable(),
            rewarded: z.number().int(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req) => {
      const { orgId, userId } = req.tenant;
      if (!(await isEnabled('referrals', { userId, orgId }))) throw httpError(404, 'not found');
      const [org] = await db
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(eq(organization.id, orgId));
      const [admin] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
      if (!org || !admin) throw httpError(404, 'not found');
      const { via, link } = await referralLink(org, admin.email); // the email only goes to Dub
      const [n] = await withTenant(req, (tx) =>
        tx.select({ n: count() }).from(rewardGrants).where(eq(rewardGrants.ruleId, 'referral')),
      );
      return { via, link, rewarded: n?.n ?? 0 };
    },
  );
};
