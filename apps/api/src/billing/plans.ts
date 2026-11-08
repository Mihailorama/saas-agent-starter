import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** config/plans.json (docs/billing.md). Also read by the worker; change both readers together. */
const Money = z.record(z.string().regex(/^[A-Z]{3}$/), z.number().nonnegative());
const Amount = z.string().regex(/^\d+(\.\d+)?$/);
const Interval = z.enum(['month', 'year']);
/** Usage the worker reports to the provider's meters (docs/billing.md "Usage-based"). */
export const METERS = ['llm_cost_micros', 'llm_tokens', 'api_calls'] as const;
/** Decimal places of a currency's minor unit (ISO 4217); 2 unless listed. Twin in billing.py. */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  KWD: 3,
  BHD: 3,
  JOD: 3,
  OMR: 3,
  TND: 3,
};
export const minorUnits = (currency: string) => MINOR_UNITS[currency] ?? 2;
const ProviderPriceId = z.string().nullable();
/**
 * One priced component, mirroring the provider's catalog; rating (tiers, proration, invoices)
 * stays in the provider. A currency has one component or an array: a hybrid is flat + metered.
 */
const Component = z.union([
  /** `per_seat`: `amount` per seat; the purchased quantity is the seat limit. */
  z.object({
    model: z.enum(['flat', 'per_seat']),
    amount: Amount,
    interval: Interval,
    providerPriceId: ProviderPriceId,
  }),
  /** Pay as you go: the provider's metered price rates what the worker reports. */
  z.object({
    model: z.literal('metered'),
    meter: z.enum(METERS),
    interval: Interval,
    providerPriceId: ProviderPriceId,
  }),
  /** Prepaid pack (a one-time price), drawn down by the plan's metered price on the same meter. */
  z.object({
    model: z.literal('credits'),
    meter: z.enum(METERS),
    pack: z.object({ credits: z.number().int().positive(), amount: Amount }),
    expiresDays: z.number().int().positive().optional(),
    providerPriceId: ProviderPriceId,
  }),
  /** Negotiated contract. `manual`: invoiced outside any PSP, set in the operator console;
   * `stripe`: a send_invoice subscription created in the Stripe dashboard (docs/billing.md). */
  z.object({
    model: z.literal('contract'),
    provider: z.enum(['manual', 'stripe']),
    providerPriceId: ProviderPriceId.default(null),
  }),
]);
/** A pre-`model` price object is a flat price (expand/contract: old files keep working). */
const Legacy = z.preprocess(
  (v) => (v && typeof v === 'object' && !('model' in v) ? { ...v, model: 'flat' } : v),
  Component,
);
const Price = z
  .union([Legacy, z.array(Legacy).min(1)])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .superRefine((cs, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (cs.filter((c) => c.model === 'flat' || c.model === 'per_seat').length > 1) {
      issue('at most one flat or per_seat component');
    }
    if (cs.some((c) => c.model === 'contract') && cs.length > 1) {
      issue('a contract price stands alone');
    }
    for (const c of cs) {
      // Credit grants apply to metered prices only.
      if (c.model === 'credits' && !cs.some((m) => m.model === 'metered' && m.meter === c.meter)) {
        issue(`credits for ${c.meter} need a metered component on the same meter`);
      }
    }
  });
/** Amounts have exactly the currency's minor-unit decimals ("29.00", JPY "3000", KWD "9.500"). */
const Prices = z.record(z.string(), Price).superRefine((prices, ctx) => {
  for (const [currency, cs] of Object.entries(prices)) {
    for (const c of cs) {
      const amount = 'amount' in c ? c.amount : c.model === 'credits' ? c.pack.amount : undefined;
      if (amount !== undefined && (amount.split('.')[1]?.length ?? 0) !== minorUnits(currency)) {
        ctx.addIssue({
          code: 'custom',
          message: `${currency} amounts have ${minorUnits(currency)} decimals: ${amount}`,
        });
      }
    }
  }
});
const Plan = z.object({
  name: z.string(),
  limits: z.object({
    seats: z.number().int().positive(),
    projects: z.number().int().nonnegative(),
    llmSpendMonthly: Money,
    /** Unmetered models (subscriptions, self-hosted): calls and/or tokens per period. */
    llmUsageMonthly: z
      .object({ calls: z.number().int().nonnegative(), tokens: z.number().int().nonnegative() })
      .partial()
      .optional(),
  }),
  llmSpendMax: Money,
  /** How far an operator may override seats/projects for one org (docs/admin.md); absent = the
   * plan's own limit. */
  limitsMax: z
    .object({ seats: z.number().int().positive(), projects: z.number().int().nonnegative() })
    .partial()
    .optional(),
  features: z.record(z.string(), z.boolean()),
  prices: Prices,
});
const Config = z
  .object({
    version: z.number().int(),
    defaultPlan: z.string(),
    pastDueGraceDays: z.number().int().nonnegative(),
    contours: z.record(
      z.string(),
      z.object({ provider: z.string(), currencies: z.array(z.string()).min(1) }),
    ),
    plans: z.record(z.string(), Plan),
  })
  .refine((c) => c.defaultPlan in c.plans, 'defaultPlan must be one of plans');

export type Plan = z.infer<typeof Plan>;
/** The components of one plan in one currency. */
export type Price = z.infer<typeof Price>;
export type PriceComponent = Price[number];
export type PriceModel = PriceComponent['model'];
export type Limit = 'seats' | 'projects';

export const parsePlans = (json: string) => Config.parse(JSON.parse(json));
/** PLANS_FILE: the same variable the worker reads (worker/settings.py). */
export const plans = parsePlans(
  readFileSync(
    process.env.PLANS_FILE || new URL('../../../../config/plans.json', import.meta.url),
    'utf8',
  ),
);

export const planById = (id: string | null | undefined): [string, Plan] =>
  id && plans.plans[id]
    ? [id, plans.plans[id]]
    : [plans.defaultPlan, plans.plans[plans.defaultPlan]!];

/** Plan and component with this provider price id (plan changes in a portal, webhook items). */
export function componentByProviderPriceId(priceId: string) {
  for (const [planId, p] of Object.entries(plans.plans)) {
    for (const c of Object.values(p.prices).flat()) {
      if (c.providerPriceId === priceId) return { planId, component: c };
    }
  }
  return undefined;
}
export const planByProviderPriceId = (priceId: string) =>
  componentByProviderPriceId(priceId)?.planId;

/** Components sold through a hosted checkout as one subscription (not packs, not contracts). */
export const subscribable = (price: Price | undefined) =>
  (price ?? []).filter(
    (c) => c.model === 'flat' || c.model === 'per_seat' || c.model === 'metered',
  );

export const contour = (id: string) => {
  const c = plans.contours[id];
  if (!c) throw new Error(`billing contour ${id} is not in config/plans.json`);
  return c;
};
