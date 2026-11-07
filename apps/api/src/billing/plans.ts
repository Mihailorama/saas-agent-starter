import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** config/plans.json (docs/billing.md). Also read by the worker; change both readers together. */
const Money = z.record(z.string().regex(/^[A-Z]{3}$/), z.number().nonnegative());
const Price = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/),
  interval: z.enum(['month', 'year']),
  providerPriceId: z.string().nullable(),
});
const Plan = z.object({
  name: z.string(),
  limits: z.object({
    seats: z.number().int().positive(),
    projects: z.number().int().nonnegative(),
    llmSpendMonthly: Money,
  }),
  llmSpendMax: Money,
  /** How far an operator may override seats/projects for one org (docs/admin.md); absent = the
   * plan's own limit. */
  limitsMax: z
    .object({ seats: z.number().int().positive(), projects: z.number().int().nonnegative() })
    .partial()
    .optional(),
  features: z.record(z.string(), z.boolean()),
  prices: z.record(z.string(), Price),
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
export type Price = z.infer<typeof Price>;
export type Limit = 'seats' | 'projects';

export const plans = Config.parse(
  JSON.parse(readFileSync(new URL('../../../../config/plans.json', import.meta.url), 'utf8')),
);

export const planById = (id: string | null | undefined): [string, Plan] =>
  id && plans.plans[id]
    ? [id, plans.plans[id]]
    : [plans.defaultPlan, plans.plans[plans.defaultPlan]!];

/** Plan whose price for some currency is this provider price id (plan changes in a portal). */
export const planByProviderPriceId = (priceId: string) =>
  Object.entries(plans.plans).find(([, p]) =>
    Object.values(p.prices).some((x) => x.providerPriceId === priceId),
  )?.[0];

export const contour = (id: string) => {
  const c = plans.contours[id];
  if (!c) throw new Error(`billing contour ${id} is not in config/plans.json`);
  return c;
};
