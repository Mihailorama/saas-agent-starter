// Re-auth, audit trail, TOTP replay protection and the org 2FA policy on Better Auth's own
// organization endpoints (ADR 0017). A Better Auth plugin, so auth.ts only lists it; the
// twoFactor and passkey plugins do the actual work.
import { createHmac } from 'node:crypto';
import { auditLog, invitation, member, organization, twoFactor, withOrg } from '@app/db';
import type { BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  type AuthMiddleware,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
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

/** RFC 6238 code for one 30 s step, as the twoFactor plugin computes it (SHA-1, 6 digits). */
function totpAt(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  return ((h.readUInt32BE(h[h.length - 1]! & 15) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
}

/**
 * The plugin accepts a code for the current step +-1 and does not remember used ones. Before
 * it runs, find the step this code belongs to and claim it atomically: a code (or an older
 * one) that was already accepted is refused, also across concurrent requests.
 */
const rejectReplayedTotp: AuthMiddleware = createAuthMiddleware(async (ctx) => {
  const session = await getSessionFromCtx(ctx);
  let userId = session?.user.id;
  if (!userId) {
    const cookie = ctx.context.createAuthCookie('two_factor').name;
    const challenge = await ctx.getSignedCookie(cookie, ctx.context.secret);
    if (!challenge) return; // the plugin answers 401
    userId = (await ctx.context.internalAdapter.findVerificationValue(challenge))?.value;
  }
  const [row] = userId ? await db.select().from(twoFactor).where(eq(twoFactor.userId, userId)) : [];
  if (!row) return;
  // ponytail: legacy "base32:" secrets (pre-1.7 plugin rows) never match here and stay unprotected.
  const secret = await symmetricDecrypt({ key: ctx.context.secretConfig, data: row.secret });
  const code = String((ctx.body as { code?: unknown })?.code ?? '');
  const now = Math.floor(Date.now() / 30_000);
  const step = [now - 1, now, now + 1].find((s) => totpAt(secret, s) === code);
  if (step === undefined) return; // wrong code: the plugin rejects and counts it
  const claimed = await db
    .update(twoFactor)
    .set({ lastTotpStep: step })
    .where(
      and(
        eq(twoFactor.id, row.id),
        or(isNull(twoFactor.lastTotpStep), lt(twoFactor.lastTotpStep, step)),
      ),
    )
    .returning({ id: twoFactor.id });
  if (!claimed.length) {
    throw new APIError('UNAUTHORIZED', { message: 'Invalid code', code: 'INVALID_CODE' });
  }
});

// Organization endpoints a member without 2FA may still call (join, leave, switch, create).
const ORG_OPEN = new Set([
  '/organization/create',
  '/organization/check-slug',
  '/organization/set-active',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
  '/organization/leave',
]);

/**
 * requireRole enforces the org 2FA policy on our routes; this does the same for Better Auth's
 * mutating organization endpoints (invite, roles, remove member, update, delete...). Reads stay
 * open so the shell can render and send the user to enrolment.
 */
/** The organization a Better Auth organization endpoint acts on, as Better Auth picks it:
 * explicit org (id or slug), the invitation's org, else the session's active org. */
export async function targetOrg(
  body: unknown,
  session: { session: unknown } | null,
): Promise<string | undefined> {
  const b = (body ?? {}) as {
    organizationId?: unknown;
    organizationSlug?: unknown;
    invitationId?: unknown;
  };
  if (typeof b.organizationId === 'string') return b.organizationId;
  if (typeof b.organizationSlug === 'string') {
    const [org] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, b.organizationSlug));
    return org?.id;
  }
  if (typeof b.invitationId === 'string') {
    const [inv] = await db
      .select({ orgId: invitation.organizationId })
      .from(invitation)
      .where(eq(invitation.id, b.invitationId));
    return inv?.orgId;
  }
  return (
    (session?.session as { activeOrganizationId?: string | null })?.activeOrganizationId ??
    undefined
  );
}

const enforceOrgPolicy: AuthMiddleware = createAuthMiddleware(async (ctx) => {
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  if ((session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) return;
  const orgId = await targetOrg(ctx.body, session);
  if (!orgId) return;
  const [org] = await db
    .select({ required: organization.requireTwoFactor })
    .from(organization)
    .where(eq(organization.id, orgId));
  if (org?.required) {
    throw new APIError('FORBIDDEN', {
      message: 'two-factor authentication required',
      code: 'TWO_FACTOR_REQUIRED',
    });
  }
});

export const mfaGuard = () =>
  ({
    id: 'mfa-guard',
    hooks: {
      before: [
        { matcher: (ctx) => ctx.path === '/two-factor/verify-totp', handler: rejectReplayedTotp },
        {
          matcher: (ctx) =>
            ctx.request?.method === 'POST' &&
            (ctx.path ?? '').startsWith('/organization/') &&
            !ORG_OPEN.has(ctx.path ?? ''),
          handler: enforceOrgPolicy,
        },
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
