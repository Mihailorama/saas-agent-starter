// Operator console rules that must hold on Better Auth's own endpoints too (docs/admin.md):
// a "view as user" session is read-only, and a suspended organization cannot be entered or
// changed. A Better Auth plugin like mfa.ts, so auth.ts only lists it.
import { organization, user } from '@app/db';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from './db.ts';
import { env } from './env.ts';
import { targetOrg } from './mfa.ts';

/** Error texts the web matches on (apps/web/src/pages/shell.tsx). */
export const ORG_SUSPENDED = 'organization suspended';
export const READ_ONLY = 'read-only while viewing as a user';

/** Listed in OPERATOR_EMAILS with a verified address: the only way to be an operator. */
export const isListedOperator = (u: { email: string; emailVerified: boolean }) =>
  u.emailVerified && env.OPERATOR_EMAILS.includes(u.email.toLowerCase());

/**
 * Applies OPERATOR_EMAILS to the admin plugin's `user.role` (which its impersonation checks):
 * listed accounts become `operator`, everyone else who still has it goes back to `user`. Runs at
 * API start and as `pnpm --filter api operators:sync`; requireOperator also promotes a listed
 * account on its first request. Access itself is decided by the list, never by the role alone.
 */
export async function syncOperators() {
  const email = sql<string>`lower(${user.email})`;
  const emails = env.OPERATOR_EMAILS;
  const promoted = emails.length
    ? await db
        .update(user)
        .set({ role: 'operator' })
        .where(and(inArray(email, emails), sql`${user.role} is distinct from 'operator'`))
        .returning({ id: user.id })
    : [];
  const demoted = await db
    .update(user)
    .set({ role: 'user' })
    .where(and(eq(user.role, 'operator'), emails.length ? notInArray(email, emails) : undefined))
    .returning({ id: user.id });
  return { promoted: promoted.length, demoted: demoted.length };
}

// What a "view as user" session may still POST: leave it, sign out, switch between that user's
// organizations (changes only this session).
const READ_ONLY_OPEN = new Set([
  '/admin/stop-impersonating',
  '/sign-out',
  '/organization/set-active',
]);
// Organization endpoints that still work for a suspended org: leaving it, declining to join.
const SUSPENDED_OPEN = new Set([
  '/organization/create',
  '/organization/check-slug',
  '/organization/leave',
  '/organization/reject-invitation',
]);

export const operatorGuard = () =>
  ({
    id: 'operator-guard',
    hooks: {
      before: [
        // The admin and API key plugins' HTTP endpoints are closed (app.ts routes them to 404).
        // This holds for any URL spelling Better Auth's router resolves to them (`//`, %-encoding):
        // ctx.path is the matched endpoint. Server-side auth.api calls carry no request.
        {
          matcher: (ctx) =>
            Boolean(ctx.request) &&
            (ctx.path?.startsWith('/admin/') || ctx.path?.startsWith('/api-key/')) === true,
          handler: createAuthMiddleware(async () => {
            throw new APIError('NOT_FOUND', { message: 'not found' });
          }),
        },
        {
          matcher: (ctx) => ctx.request?.method === 'POST',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            const viewing = (session?.session as { impersonatedBy?: string | null } | undefined)
              ?.impersonatedBy;
            if (viewing && !READ_ONLY_OPEN.has(ctx.path ?? '')) {
              throw new APIError('FORBIDDEN', { message: READ_ONLY, code: 'READ_ONLY' });
            }
            const path = ctx.path ?? '';
            if (!session || !path.startsWith('/organization/') || SUSPENDED_OPEN.has(path)) return;
            // set-active with organizationId null clears the active org: always allowed.
            if (
              path === '/organization/set-active' &&
              !(ctx.body as { organizationId?: unknown })?.organizationId &&
              !(ctx.body as { organizationSlug?: unknown })?.organizationSlug
            ) {
              return;
            }
            const orgId = await targetOrg(ctx.body, session);
            if (!orgId) return;
            const [org] = await db
              .select({ suspendedAt: organization.suspendedAt })
              .from(organization)
              .where(eq(organization.id, orgId));
            if (org?.suspendedAt) {
              throw new APIError('FORBIDDEN', { message: ORG_SUSPENDED, code: 'ORG_SUSPENDED' });
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
