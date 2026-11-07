import { randomUUID } from 'node:crypto';
import { BlockList, isIPv6 } from 'node:net';
import { z } from 'zod';
import { addInterval, planById } from './plans.ts';
import { type BillingEvent, type BillingProvider, WebhookRejected } from './provider.ts';

/**
 * YooKassa adapter over its REST API v3 (https://yookassa.ru/developers/api), no SDK.
 * YooKassa has no subscription object: the first payment saves the payment method
 * (`save_payment_method`), and the worker charges it once per period
 * (services/worker-py/worker/billing.py, SubscriptionRenewalWorkflow).
 *
 * Notifications are not signed. Following YooKassa's guidance
 * (https://yookassa.ru/developers/using-api/webhooks, "Notification authentication") we check
 * both: the sender IP is in their published ranges, and the object's current status is
 * re-read from the API; only that re-read object is trusted.
 */
export const YOOKASSA_IPS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
  '2a02:5180::/32',
];

const Payment = z.object({
  id: z.string(),
  status: z.enum(['pending', 'waiting_for_capture', 'succeeded', 'canceled']),
  amount: z.object({ value: z.string(), currency: z.string() }),
  created_at: z.string(),
  captured_at: z.string().optional(),
  confirmation: z.object({ confirmation_url: z.string().optional() }).optional(),
  payment_method: z.object({ id: z.string(), saved: z.boolean() }).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
const Notification = z.object({
  type: z.literal('notification'),
  event: z.string(),
  object: z.object({ id: z.string() }),
});

export function yookassaProvider(opts: {
  contour: string;
  shopId: string;
  secretKey: string;
  apiUrl: string;
  fetch?: typeof fetch;
  trustedIps?: string[];
}): BillingProvider {
  const auth = `Basic ${Buffer.from(`${opts.shopId}:${opts.secretKey}`).toString('base64')}`;
  const trusted = new BlockList();
  for (const cidr of opts.trustedIps ?? YOOKASSA_IPS) {
    const [net, bits] = cidr.split('/');
    trusted.addSubnet(net!, Number(bits), isIPv6(net!) ? 'ipv6' : 'ipv4');
  }

  async function api(path: string, body?: object) {
    const res = await (opts.fetch ?? fetch)(`${opts.apiUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: auth,
        ...(body && { 'content-type': 'application/json', 'idempotence-key': randomUUID() }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`YooKassa ${body ? 'POST' : 'GET'} ${path}: ${res.status}`);
    return Payment.parse(await res.json());
  }

  return {
    id: 'yookassa',

    async checkout(input) {
      const payment = await api('/payments', {
        amount: { value: input.price.amount, currency: input.currency },
        capture: true,
        save_payment_method: true,
        confirmation: { type: 'redirect', return_url: `${input.returnUrl}?checkout=success` },
        description: `${input.planName} subscription`,
        metadata: { orgId: input.orgId, planId: input.planId, kind: 'initial' },
      });
      const url = payment.confirmation?.confirmation_url;
      if (!url) throw new Error('YooKassa returned a payment without confirmation_url');
      return { url };
    },

    // No hosted customer portal: receipts come from the shop's fiscalization (54-FZ) setup, and
    // the saved card is ours to stop using (cancel).
    portal: async () => null,

    // Nothing to call: autopayments stop when we stop charging the saved method. The route sets
    // cancel_at_period_end; the renewal workflow then ends the subscription instead of charging.
    cancel: async () => {},

    async webhook(req) {
      const ip = req.ip.replace(/^::ffff:/, '');
      if (!trusted.check(ip, isIPv6(ip) ? 'ipv6' : 'ipv4')) {
        throw new WebhookRejected('sender is not a YooKassa address');
      }
      let body: unknown;
      try {
        body = JSON.parse(req.body);
      } catch {
        throw new WebhookRejected('not JSON');
      }
      const note = Notification.safeParse(body);
      if (!note.success) throw new WebhookRejected('not a notification');
      if (note.data.event !== 'payment.succeeded' && note.data.event !== 'payment.canceled') {
        return [];
      }
      // Trust the API, not the notification body.
      const p = await api(`/payments/${encodeURIComponent(note.data.object.id)}`);
      const meta = p.metadata ?? {};
      if (!meta.orgId || `payment.${p.status}` !== note.data.event) return [];

      const renewal = meta.kind === 'renewal';
      const at = p.captured_at ?? p.created_at;
      const base = {
        provider: 'yookassa',
        contour: opts.contour,
        orgId: meta.orgId,
        occurredAt: at,
        planId: meta.planId,
        currency: p.amount.currency,
      };
      if (p.status === 'canceled') {
        const failed: BillingEvent = {
          ...base,
          eventId: `${p.id}.canceled`,
          type: 'payment.failed',
        };
        return renewal
          ? [failed, { ...base, eventId: `${p.id}.past_due`, type: 'subscription.past_due' }]
          : [failed];
      }
      const [, plan] = planById(meta.planId);
      const interval = plan.prices[p.amount.currency]?.interval ?? 'month';
      const start = new Date(renewal && meta.periodStart ? meta.periodStart : at);
      return [
        { ...base, eventId: `${p.id}.succeeded`, type: 'payment.succeeded' },
        {
          ...base,
          eventId: `${p.id}.subscription`,
          type: renewal ? 'subscription.renewed' : 'subscription.activated',
          ...(p.payment_method?.saved && { paymentMethodId: p.payment_method.id }),
          periodStart: start.toISOString(),
          periodEnd: addInterval(start, interval).toISOString(),
          cancelAtPeriodEnd: false,
        },
      ];
    },
  };
}
