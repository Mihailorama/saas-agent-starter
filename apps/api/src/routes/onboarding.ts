import { apikey, invitation, member, organization, projects, type Tx } from '@app/db';
import { count, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isEnabled } from '../flags.ts';
import { httpError, requireRole, type Tenant, withTenant } from '../tenant.ts';

/**
 * Onboarding checklist (docs/onboarding.md). Each item is derived from existing data, never
 * stored. The ids are a contract: rewards rules and analytics (`onboarding_item_completed`)
 * reference them, so never rename one; add a new id instead.
 */
export const ONBOARDING_ITEMS = [
  'org_profile',
  'first_project',
  'teammate_invited',
  'two_factor',
  'api_key',
] as const;
export type OnboardingItem = (typeof ONBOARDING_ITEMS)[number];

/** Company size and website in Better Auth's organization `metadata` (JSON text). */
export const OrgProfile = z.object({
  size: z.string().min(1),
  website: z.string().min(1),
});

const has = async (q: Promise<{ n: number }[]>) => ((await q)[0]?.n ?? 0) > 0;

/** Which items are done for this tenant. Call inside withTenant (or a tx with app.org_id set). */
export async function onboardingStatus(
  tx: Tx,
  { orgId, twoFactor }: Pick<Tenant, 'orgId' | 'twoFactor'>,
): Promise<Record<OnboardingItem, boolean>> {
  // Auth tables are not under RLS: every query filters by the org explicitly.
  const [org] = await tx
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId));
  let metadata: unknown;
  try {
    metadata = JSON.parse(org?.metadata ?? 'null');
  } catch {}
  const n = { n: count() };
  return {
    org_profile: OrgProfile.safeParse(metadata).success,
    first_project: await has(tx.select(n).from(projects)),
    teammate_invited:
      (await has(tx.select(n).from(invitation).where(eq(invitation.organizationId, orgId)))) ||
      ((await tx.select(n).from(member).where(eq(member.organizationId, orgId)))[0]?.n ?? 0) > 1,
    two_factor: twoFactor,
    api_key: await has(tx.select(n).from(apikey).where(eq(apikey.referenceId, orgId))),
  };
}

const Status = z.object({
  items: z.array(z.object({ id: z.enum(ONBOARDING_ITEMS), done: z.boolean() })),
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
      return { items: ONBOARDING_ITEMS.map((id) => ({ id, done: done[id] })) };
    },
  );
};
