import { organization } from '@app/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { httpError, requireRole, withTenant } from '../tenant.ts';

// Org security policy (ADR 0017). Enforcement lives in requireRole: a member of an org that
// requires 2FA gets 403 "two-factor authentication required" until they enrol, here too.
const Policy = z.object({ requireTwoFactor: z.boolean() });
const ErrorBody = z.object({ error: z.string() });

export const securityRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['security'];

  app.get(
    '/policy',
    { preHandler: requireRole('member'), schema: { tags, response: { 200: Policy } } },
    async (req) => {
      const [org] = await withTenant(req, (tx) =>
        tx
          .select({ requireTwoFactor: organization.requireTwoFactor })
          .from(organization)
          .where(eq(organization.id, req.tenant.orgId)),
      );
      return { requireTwoFactor: org?.requireTwoFactor ?? false };
    },
  );

  app.put(
    '/policy',
    {
      preHandler: requireRole('admin'),
      schema: { tags, body: Policy, response: { 200: Policy, 400: ErrorBody } },
    },
    async (req) => {
      // The admin turning it on must already comply, or they would lock themselves out.
      if (req.body.requireTwoFactor && !req.tenant.twoFactor) {
        throw httpError(400, 'enable two-factor authentication for your account first');
      }
      const [org] = await withTenant(
        req,
        (tx) =>
          tx
            .update(organization)
            .set({ requireTwoFactor: req.body.requireTwoFactor })
            .where(eq(organization.id, req.tenant.orgId))
            .returning({ requireTwoFactor: organization.requireTwoFactor }),
        () => req.tenant.orgId,
      );
      return { requireTwoFactor: org?.requireTwoFactor ?? false };
    },
  );
};
