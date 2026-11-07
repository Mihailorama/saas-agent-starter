import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { httpError } from '../tenant.ts';
import { auditUser, authCall, ErrorBody, errorHandler, requireOperator } from './admin-common.ts';
import { adminOrgRoutes } from './admin-orgs.ts';
import { adminUserRoutes } from './admin-users.ts';

/**
 * Operator console API (docs/admin.md, ADR 0025). Not for customers: every route needs an
 * operator session (requireOperator). Reads of tenant tables across organizations go through
 * withOperatorRead (read-only role, the one RLS exception); every change goes through withOrg for
 * the organization it concerns and writes an `operator.*` audit_log row with the reason in the
 * same transaction.
 */

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.setErrorHandler(errorHandler); // inherited by the two route plugins below
  const op = { preHandler: requireOperator, schema: { tags: ['admin'], hide: true } };
  app.get(
    '/me',
    {
      ...op,
      schema: { ...op.schema, response: { 200: z.object({ id: z.string(), email: z.string() }) } },
    },
    async (req) => req.operator,
  );

  await app.register(adminOrgRoutes);
  await app.register(adminUserRoutes);
};

/** Ends "view as user" (no operator guard: the session is the user's, marked impersonatedBy). */
export const impersonationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.setErrorHandler(errorHandler);
  app.post(
    '/stop',
    { schema: { hide: true, response: { 200: z.object({ userId: z.string() }), 400: ErrorBody } } },
    async (req, reply) => {
      const headers = fromNodeHeaders(req.headers);
      const s = await auth.api.getSession({ headers });
      const operatorId = s?.session.impersonatedBy;
      if (!s || !operatorId) throw httpError(400, 'not viewing as a user');
      req.operator = { id: operatorId, email: '' };
      // If Better Auth fails, no row; if a row fails, the started row's expiresAt still bounds it.
      const res = await auditUser(
        req,
        s.user.id,
        'impersonation.ended',
        'stopped by the operator',
        () => authCall(auth.api.stopImpersonating({ headers, returnHeaders: true })),
      );
      reply.header('set-cookie', res.headers.getSetCookie());
      return { userId: s.user.id };
    },
  );
};
