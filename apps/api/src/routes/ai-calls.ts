import { aiCalls } from '@app/db';
import { and, count, desc, eq, gte, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { httpError, requireRole, withTenant } from '../tenant.ts';

/** Audit log of LLM calls (written by the worker's ai.call_llm). Org admins only, read-only. */
const AiCall = z.object({
  id: z.uuid(),
  actorId: z.string().nullable(),
  purpose: z.string(),
  provider: z.string(),
  requestModel: z.string(),
  responseModel: z.string().nullable(),
  promptTemplateId: z.string(),
  promptTemplateVersion: z.string(),
  requestKey: z.string(),
  responseKey: z.string().nullable(),
  contentExpiresAt: z.string(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  cost: z.number().nullable(),
  costCurrency: z.string().nullable(),
  latencyMs: z.number().int(),
  status: z.enum(['ok', 'error']),
  errorClass: z.string().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  contour: z.string(),
  createdAt: z.string(),
});
const Filters = z.object({
  purpose: z.string().max(100).optional(),
  /** Matches the requested or the reported model id. */
  model: z.string().max(200).optional(),
  status: z.enum(['ok', 'error']).optional(),
  /** Inclusive lower / exclusive upper bound on created_at (ISO date or date-time). */
  from: z.iso
    .date()
    .or(z.iso.datetime({ offset: true }))
    .optional(),
  to: z.iso
    .date()
    .or(z.iso.datetime({ offset: true }))
    .optional(),
});
const Page = Filters.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const OrgParams = z.object({ orgId: z.string().min(1) });
const ErrorBody = z.object({ error: z.string() });

const where = (f: z.infer<typeof Filters>) =>
  and(
    ...([
      f.purpose && eq(aiCalls.purpose, f.purpose),
      f.model && or(eq(aiCalls.requestModel, f.model), eq(aiCalls.responseModel, f.model)),
      f.status && eq(aiCalls.status, f.status),
      f.from && gte(aiCalls.createdAt, new Date(f.from)),
      f.to && lt(aiCalls.createdAt, new Date(f.to)),
    ].filter(Boolean) as SQL[]),
  );

const dto = ({ orgId: _, createdAt, contentExpiresAt, ...c }: typeof aiCalls.$inferSelect) => ({
  ...c,
  createdAt: createdAt.toISOString(),
  contentExpiresAt: contentExpiresAt.toISOString(),
});

/** The path names the org explicitly (auditors share links); it must be the active one. */
const activeOrg = (req: FastifyRequest, orgId: string) => {
  if (orgId !== req.tenant.orgId) throw httpError(403, 'not the active organization');
};

export const aiCallRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = { preHandler: requireRole('admin') };
  const tags = ['ai'];

  app.get(
    '/',
    {
      ...admin,
      schema: {
        tags,
        params: OrgParams,
        querystring: Page,
        response: {
          200: z.object({ items: z.array(AiCall), total: z.number().int() }),
          403: ErrorBody,
        },
      },
    },
    async (req) => {
      activeOrg(req, req.params.orgId);
      const { limit, offset, ...filters } = req.query;
      return withTenant(req, async (tx) => {
        const rows = await tx
          .select()
          .from(aiCalls)
          .where(where(filters))
          .orderBy(desc(aiCalls.createdAt), desc(aiCalls.id))
          .limit(limit)
          .offset(offset);
        const [totals] = await tx.select({ total: count() }).from(aiCalls).where(where(filters));
        return { items: rows.map(dto), total: totals?.total ?? 0 };
      });
    },
  );

  app.get(
    '/export',
    { ...admin, schema: { tags, params: OrgParams, querystring: Filters } },
    async (req, reply) => {
      activeOrg(req, req.params.orgId);
      // ponytail: builds the whole file in memory; stream with a cursor past ~100k rows.
      const rows = await withTenant(req, (tx) =>
        tx.select().from(aiCalls).where(where(req.query)).orderBy(aiCalls.createdAt),
      );
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .type('application/x-ndjson')
        .header('content-disposition', `attachment; filename="ai-calls-${day}.jsonl"`)
        .send(rows.map((r) => `${JSON.stringify(dto(r))}\n`).join(''));
    },
  );
};
