import { randomBytes } from 'node:crypto';
import { member, organization, user } from '@app/db';
import * as Sentry from '@sentry/node-core';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db.ts';
import { env } from '../env.ts';
import { isEnabled } from '../flags.ts';
import { dub } from './dub.ts';
import type { BillingEvent } from './provider.ts';
import { providerFor } from './registry.ts';
import { rewards, triggerRewards } from './rewards.ts';

/**
 * Referrals (docs/growth.md, flag `referrals`). Native: each org has a code (`?ref=<code>` on the
 * sign-up page) and a provider promotion code for first-time customers; a paid invoice of the
 * referred org emits `referral.converted`, which starts the referrer's RewardWorkflow. With
 * DUB_API_KEY, Dub Partners does links, attribution and payouts instead.
 */

/** What the sign-up form may store as `user.referralCode`: a code or Dub's click id. */
export const cleanReferral = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;

/** After `userId` created `orgId` (auth.ts): attributes it to the referrer, once. Never throws. */
export async function attachReferral(orgId: string, userId: string) {
  try {
    if (!(await isEnabled('referrals', { userId, orgId }))) return;
    const [u] = await db.select({ code: user.referralCode }).from(user).where(eq(user.id, userId));
    if (!u?.code) return;
    await db.update(user).set({ referralCode: null }).where(eq(user.id, userId)); // first org only
    let referredBy: string;
    const d = dub();
    if (d) {
      await d.trackLead(u.code, orgId);
      referredBy = 'dub';
    } else {
      const [ref] = await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.referralCode, u.code));
      if (!ref || ref.id === orgId) return;
      // Self-referral: a member of the referring org cannot refer a new org of their own.
      const [own] = await db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.organizationId, ref.id), eq(member.userId, userId)));
      if (own) return;
      referredBy = ref.id;
    }
    await db
      .update(organization)
      .set({ referredBy })
      .where(and(eq(organization.id, orgId), isNull(organization.referredBy)));
  } catch (err) {
    Sentry.captureException(err);
  }
}

/** The org's referral link; creates its code and promotion code the first time. */
export async function referralLink(org: { id: string; name: string }, adminEmail: string) {
  const d = dub();
  if (d) {
    return {
      via: 'dub' as const,
      link: await d.partnerLink({ orgId: org.id, name: org.name, email: adminEmail }),
    };
  }
  const [row] = await db
    .select({ code: organization.referralCode })
    .from(organization)
    .where(eq(organization.id, org.id));
  let code = row?.code ?? null;
  if (!code) {
    const [set] = await db
      .update(organization)
      .set({ referralCode: randomBytes(6).toString('base64url') })
      .where(and(eq(organization.id, org.id), isNull(organization.referralCode)))
      .returning({ code: organization.referralCode });
    code = set?.code ?? null;
    // ponytail: a failed promotion code is not retried; the link still attributes and rewards.
    const p = providerFor(env.BILLING_CONTOUR);
    if (code && p.createPromotionCode && rewards.referral) {
      await p
        .createPromotionCode({
          code,
          couponId: rewards.referral.couponId,
          referrerOrgId: org.id,
          key: `referral-${code}`,
        })
        .catch((err) => Sentry.captureException(err));
    }
    if (!code) return referralLink(org, adminEmail); // a concurrent request set it
  }
  return { via: 'native' as const, link: `${env.BETTER_AUTH_URL}/sign-in?ref=${code}` };
}

/** For checkout: the referrer's promotion code, if this org was referred natively. */
export async function checkoutReferral(orgId: string) {
  const [o] = await db
    .select({ by: organization.referredBy })
    .from(organization)
    .where(eq(organization.id, orgId));
  if (!o?.by || o.by === 'dub') return undefined;
  const [r] = await db
    .select({ code: organization.referralCode })
    .from(organization)
    .where(eq(organization.id, o.by));
  return r?.code ? { promotionCode: r.code, referrerOrgId: o.by } : undefined;
}

/** Billing webhook events (routes/billing.ts): rewards the referrer, or reports the sale to Dub. */
export async function onReferralEvent(e: BillingEvent) {
  const ctx = { userId: `org:${e.orgId}`, orgId: e.orgId };
  if (e.type === 'referral.converted' && e.referrerOrgId) {
    if (!(await isEnabled('referrals', ctx))) return;
    await triggerRewards('referral.converted', {
      orgId: e.referrerOrgId,
      subject: e.orgId,
      userId: ctx.userId,
    });
  }
  const d = dub();
  if (d && e.type === 'payment.succeeded' && e.amount && e.currency) {
    const [o] = await db
      .select({ by: organization.referredBy })
      .from(organization)
      .where(eq(organization.id, e.orgId));
    if (o?.by === 'dub' && (await isEnabled('referrals', ctx))) {
      await d.trackSale({
        orgId: e.orgId,
        amount: e.amount,
        currency: e.currency,
        invoiceId: e.invoiceId,
      });
    }
  }
}
