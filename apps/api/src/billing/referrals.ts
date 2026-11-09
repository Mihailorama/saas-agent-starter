import { randomInt } from 'node:crypto';
import { member, organization, subscriptions, user, withOrg } from '@app/db';
import * as Sentry from '@sentry/node-core';
import { WorkflowNotFoundError } from '@temporalio/client';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db.ts';
import { env } from '../env.ts';
import { isEnabled } from '../flags.ts';
import { rewardWorkflowId, temporal } from '../temporal.ts';
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

/** Stripe promotion codes take letters and digits only; uppercase, without look-alikes. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () =>
  Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/**
 * The org's referral link. Created once and kept in the organization row: the native code and its
 * provider promotion code, or Dub's partner link. Never throws for a provider or Dub error: the
 * page then shows no link and the next view tries again.
 */
export async function referralLink(org: { id: string; name: string }, adminEmail: string) {
  const [row] = await db
    .select({ code: organization.referralCode, link: organization.referralLink })
    .from(organization)
    .where(eq(organization.id, org.id));
  const d = dub();
  if (d) {
    if (row?.link) return { via: 'dub' as const, link: row.link };
    const link = await d
      .partnerLink({ orgId: org.id, name: org.name, email: adminEmail })
      .catch((err) => void Sentry.captureException(err));
    if (link) {
      await db.update(organization).set({ referralLink: link }).where(eq(organization.id, org.id));
    }
    return { via: 'dub' as const, link: link ?? null };
  }
  let code = row?.code ?? null;
  if (!code) {
    const [set] = await db
      .update(organization)
      .set({ referralCode: newCode() })
      .where(and(eq(organization.id, org.id), isNull(organization.referralCode)))
      .returning({ code: organization.referralCode });
    if (!set?.code) return referralLink(org, adminEmail); // a concurrent request set it
    code = set.code;
    // Once, with the code. ponytail: a failed promotion code is not retried; the link still
    // attributes and rewards, only the referred discount is missing.
    try {
      const p = providerFor(env.BILLING_CONTOUR);
      if (p.createPromotionCode && rewards.referral) {
        await p.createPromotionCode({
          code,
          couponId: rewards.referral.couponId,
          referrerOrgId: org.id,
          key: `referral-${code}`,
        });
      }
    } catch (err) {
      Sentry.captureException(err);
    }
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

/** Same payer: the referrer's and the referred customer's saved cards share a fingerprint. */
async function samePayer(e: BillingEvent, referrerOrgId: string) {
  const [sub] = await withOrg(db, referrerOrgId, (tx) => tx.select().from(subscriptions));
  if (!sub?.customerId || !e.customerId) return false; // a free referrer has no card to compare
  const p = providerFor(e.contour);
  if (!p.cardFingerprints) return false;
  const theirs = new Set(await p.cardFingerprints(sub.customerId));
  return (await p.cardFingerprints(e.customerId)).some((f) => theirs.has(f));
}

/**
 * Billing webhook events (routes/billing.ts): rewards the referrer, or reports the sale to Dub.
 * Never throws: a provider or Dub outage must not fail the webhook (Sentry gets the error).
 */
export async function onReferralEvent(e: BillingEvent) {
  const ctx = { userId: `org:${e.orgId}`, orgId: e.orgId };
  try {
    if (e.type === 'referral.converted' && e.referrerOrgId) {
      if (!(await isEnabled('referrals', ctx))) return;
      if (await samePayer(e, e.referrerOrgId)) return; // self-referral with a second org
      await triggerRewards('referral.converted', {
        orgId: e.referrerOrgId,
        subject: e.orgId,
        userId: ctx.userId,
      });
    }
    if (e.type === 'referral.voided' && e.referrerOrgId) {
      // The reward waits holdDays in its workflow: ending it grants nothing (terminate, not
      // cancel: it takes effect even while no worker runs). One granted already stays.
      const id = rewardWorkflowId({ orgId: e.referrerOrgId, ruleId: 'referral', subject: e.orgId });
      await (await temporal()).workflow
        .getHandle(id)
        .terminate('referral voided: refund or dispute')
        .catch((err) => {
          if (!(err instanceof WorkflowNotFoundError)) throw err;
        });
    }
    const d = dub();
    if (d && e.type === 'payment.succeeded' && e.amount && e.currency) {
      const [o] = await db
        .select({ by: organization.referredBy })
        .from(organization)
        .where(eq(organization.id, e.orgId));
      if (o?.by === 'dub' && (await isEnabled('referrals', ctx))) {
        // ponytail: a sale lost in a Dub outage is not retried; move it to a worker activity if
        // payouts depend on it.
        await d.trackSale({
          orgId: e.orgId,
          amount: e.amount,
          currency: e.currency,
          invoiceId: e.invoiceId,
        });
      }
    }
  } catch (err) {
    Sentry.captureException(err);
  }
}
