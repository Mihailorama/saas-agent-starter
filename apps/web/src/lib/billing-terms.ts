// Plain TS without runtime imports: scripts/check-legal.test.mjs runs it under Node.
import type { Ok } from '@/lib/api';

type Billing = Ok<'/api/billing/', 'get'>;
const RENEWING = ['flat', 'per_seat'];

/**
 * Taxes, renewal and cancellation as they apply to this organization, next to the prices (docs/ui.md
 * "Dark patterns"): from its provider, the models of the plans on offer and the viewer's rights,
 * as the refund policy (apps/site/src/legal.ts) builds them from config/plans.json.
 */
export function billingTerms(b: Billing, taxNote: string): string[] {
  const current = b.plans.find((p) => p.id === b.planId);
  if (b.provider === 'manual' || current?.models.includes('contract')) {
    return [
      'This plan follows your contract: its prices, taxes, renewal and cancellation terms apply. Contact us to change it.',
    ];
  }
  const sold = b.plans.filter((p) => p.checkout);
  const models = new Set([...sold, ...(current ? [current] : [])].flatMap((p) => p.models));
  const paid = b.status === 'active' || b.status === 'past_due';
  const lines: string[] = [];
  if (sold.length || paid) lines.push(taxNote);
  if (RENEWING.some((m) => models.has(m)))
    lines.push('Paid plans renew automatically at the end of each billing period until cancelled.');
  if (models.has('metered')) lines.push('Usage is billed after each period at the prices shown.');
  if (models.has('credits')) lines.push('Credit packs are charged once when you buy them.');
  if (paid && b.selfService.cancel) {
    lines.push(
      b.canManage
        ? 'Cancel any time on this page: the plan stays active until the period ends.'
        : 'An organization admin can cancel it on this page; it stays active until the period ends.',
    );
  } else if (!paid && sold.length && b.canManage) {
    lines.push('After you subscribe, you can cancel any time on this page.');
  }
  return lines;
}
