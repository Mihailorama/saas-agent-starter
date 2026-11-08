import { apikey, invitation, member, organization, projects, type Tx } from '@app/db';
import { and, eq, exists, gt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { OrgMetadata } from '../auth.ts';
import { isEnabled } from '../flags.ts';
import { httpError, type Role, requireRole, roleRank, type Tenant, withTenant } from '../tenant.ts';

/**
 * Onboarding checklist (docs/onboarding.md). Each item is derived from existing data, never
 * stored. The ids are a contract: rewards rules reference them, so never rename one; add a new
 * id instead. The role is the lowest that can complete the item (Better Auth org permissions).
 */
export const ONBOARDING_ITEMS = {
  org_profile: 'admin',
  first_project: 'member',
  teammate_invited: 'admin',
  two_factor: 'member',
  api_key: 'admin',
} as const satisfies Record<string, Role>;
export type OnboardingItem = keyof typeof ONBOARDING_ITEMS;
const ids = Object.keys(ONBOARDING_ITEMS) as [OnboardingItem, ...OnboardingItem[]];

/** Which items are done for this tenant. Call inside withTenant (or a tx with app.org_id set). */
export async function onboardingStatus(
  tx: Tx,
  { orgId, twoFactor }: Pick<Tenant, 'orgId' | 'twoFactor'>,
): Promise<Record<OnboardingItem, boolean>> {
  // Auth tables are not under RLS: every subquery filters by the org explicitly.
  const one = sql`1`;
  const [row] = await tx
    .select({
      metadata: organization.metadata,
      first_project: exists(tx.select({ one }).from(projects)),
      invited: exists(
        tx
          .select({ one })
          .from(invitation)
          .where(
            and(
              eq(invitation.organizationId, orgId),
              eq(invitation.status, 'pending'),
              gt(invitation.expiresAt, sql`now()`),
            ),
          ),
      ),
      members: sql<number>`(select count(*)::int from ${member} where ${member.organizationId} = ${orgId})`,
      api_key: exists(tx.select({ one }).from(apikey).where(eq(apikey.referenceId, orgId))),
    })
    .from(organization)
    .where(eq(organization.id, orgId));
  let metadata: unknown;
  try {
    metadata = JSON.parse(row?.metadata ?? 'null');
  } catch {}
  return {
    org_profile: OrgMetadata.required().safeParse(metadata).success,
    first_project: Boolean(row?.first_project),
    teammate_invited: Boolean(row?.invited) || (row?.members ?? 0) > 1,
    two_factor: twoFactor,
    api_key: Boolean(row?.api_key),
  };
}

const Status = z.object({
  items: z.array(z.object({ id: z.enum(ids), done: z.boolean() })),
});

export const onboardingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    {
      preHandler: requireRole('member'),
      schema: {
        tags: ['onboarding'],
        response: { 200: Status, 404: z.object({ error: z.string() }) },
      },
    },
    async (req) => {
      if (!(await isEnabled('onboarding', req.tenant))) throw httpError(404, 'not found');
      const done = await withTenant(req, (tx) => onboardingStatus(tx, req.tenant));
      // Only what the caller's role can complete (members cannot invite, edit the org or make keys).
      const mine = ids.filter((id) => req.tenant.rank >= roleRank(ONBOARDING_ITEMS[id]));
      return { items: mine.map((id) => ({ id, done: done[id] })) };
    },
  );
};
