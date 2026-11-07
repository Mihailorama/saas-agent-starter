// Re-auth and audit trail for 2FA and passkey changes (ADR 0017). A Better Auth plugin, so
// auth.ts only lists it; the twoFactor and passkey plugins do the actual work.
import { auditLog, member, withOrg } from '@app/db';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { db } from './db.ts';

/** Sensitive changes need a sign-in (password + 2FA, or passkey) at most this old. */
export const REAUTH_MAX_AGE_SECONDS = 10 * 60;

// Better Auth path -> audit action; `fresh` = the change also needs a recent sign-in.
const EVENTS: Record<string, { action: string; fresh?: boolean }> = {
  '/two-factor/verify-totp': { action: 'two_factor.enabled' }, // only when it completes enrolment
  '/two-factor/disable': { action: 'two_factor.disabled', fresh: true },
  '/two-factor/generate-backup-codes': {
    action: 'two_factor.backup_codes_regenerated',
    fresh: true,
  },
  '/passkey/verify-registration': { action: 'passkey.added' },
  '/passkey/update-passkey': { action: 'passkey.renamed' },
  '/passkey/delete-passkey': { action: 'passkey.deleted', fresh: true },
};

// The endpoints replace the session, so the actor is resolved before and read back after.
const actors = new WeakMap<Request, string>();

/**
 * audit_log is tenant-scoped: one row per organization the user belongs to, so each org's
 * admins see their members' security changes. Written after Better Auth commits the change
 * (separate transaction): a crash in between loses the row, never the other way round.
 */
async function audit(actorId: string, action: string, target: string, ip: string | null) {
  const orgs = await db
    .select({ orgId: member.organizationId })
    .from(member)
    .where(eq(member.userId, actorId));
  for (const { orgId } of orgs) {
    await withOrg(db, orgId, (tx) =>
      tx.insert(auditLog).values({ orgId, actorId, action, target, ip }),
    );
  }
}

export const mfaGuard = () =>
  ({
    id: 'mfa-guard',
    hooks: {
      before: [
        {
          matcher: (ctx) => (ctx.path ?? '') in EVENTS,
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            // No session: the endpoint answers 401 itself, or it is the sign-in TOTP step.
            if (!session || !ctx.request) return;
            const user = session.user as { id: string; twoFactorEnabled?: boolean | null };
            if (ctx.path === '/two-factor/verify-totp' && user.twoFactorEnabled) return;
            const age = Date.now() - new Date(session.session.createdAt).getTime();
            if (EVENTS[ctx.path]?.fresh && age > REAUTH_MAX_AGE_SECONDS * 1000) {
              throw new APIError('FORBIDDEN', {
                message: 'Sign in again to make this change',
                code: 'SESSION_NOT_FRESH',
              });
            }
            actors.set(ctx.request, user.id);
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => (ctx.path ?? '') in EVENTS,
          handler: createAuthMiddleware(async (ctx) => {
            const actorId = ctx.request && actors.get(ctx.request);
            if (!ctx.request || !actorId || isAPIError(ctx.context.returned)) return;
            const returned = ctx.context.returned as { id?: string } | undefined;
            const body = ctx.body as { id?: string } | undefined;
            const target = ctx.path.startsWith('/passkey/')
              ? (body?.id ?? returned?.id ?? actorId)
              : actorId;
            // app.ts sets this header from Fastify's req.ip (TRUST_PROXY-aware).
            const ip = ctx.request.headers.get('x-forwarded-for');
            await audit(actorId, EVENTS[ctx.path]!.action, target, ip);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
