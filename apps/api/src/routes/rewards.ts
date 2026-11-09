import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { applyReward, ruleById } from '../billing/rewards.ts';
import { env } from '../env.ts';
import { bearerToken, httpError } from '../tenant.ts';
import { sameString } from './support.ts';

/**
 * Worker -> API (docs/growth.md): applies a money or coupon reward through the billing provider,
 * which lives here (apps/api/src/billing). Not proxied by the web origin (only /api and /mcp);
 * the worker calls the API service directly with INTERNAL_API_TOKEN; unset = 404.
 */
export const rewardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/apply',
    {
      schema: {
        hide: true,
        body: z.object({
          orgId: z.string().min(1).max(100),
          ruleId: z.string().min(1).max(40),
          key: z.string().min(1).max(255),
        }),
        response: {
          200: z.object({
            via: z.enum(['entitlement', 'balance_credit', 'coupon', 'manual']),
            reward: z.record(z.string(), z.unknown()),
            ref: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      if (!env.INTERNAL_API_TOKEN) throw httpError(404, 'not found');
      if (!sameString(bearerToken(req) ?? '', env.INTERNAL_API_TOKEN)) {
        throw httpError(401, 'unauthorized');
      }
      const rule = ruleById(req.body.ruleId);
      if (!rule) throw httpError(404, 'unknown rule');
      return applyReward(req.body.orgId, rule, req.body.key);
    },
  );
};
