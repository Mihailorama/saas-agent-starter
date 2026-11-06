import { aiCalls, aiDatasetItems, aiScores, auditLog } from '@app/db';
import { and, asc, count, desc, eq, gte, lt, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../env.ts';
import { getAiContent } from '../s3.ts';
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
const CallParams = OrgParams.extend({ id: z.uuid() });
const Score = z.object({
  id: z.uuid(),
  source: z.enum(['user', 'judge', 'rule']),
  name: z.string(),
  value: z.number(),
  comment: z.string().nullable(),
  actorId: z.string().nullable(),
  judgeCallId: z.uuid().nullable(),
  createdAt: z.string(),
});
const DatasetItem = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'exported']),
  addedBy: z.string().nullable(),
  createdAt: z.string(),
});
const num = z.number().nullable();
const VersionStats = z.object({
  purpose: z.string(),
  template: z.string(),
  version: z.string(),
  model: z.string(),
  calls: z.number().int(),
  errorRate: z.number(),
  avgCost: num,
  avgLatencyMs: z.number(),
  judgeScore: num,
  judged: z.number().int(),
  userScore: num,
  reviewed: z.number().int(),
});
const DayStats = z.object({
  day: z.string(),
  purpose: z.string(),
  calls: z.number().int(),
  errors: z.number().int(),
  cost: num,
  judgeScore: num,
  userScore: num,
});
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

const iso = <T extends { createdAt: Date }>({ createdAt, ...rest }: T) => ({
  ...rest,
  createdAt: createdAt.toISOString(),
});
const scoreDto = ({ orgId: _, callId: __, ...s }: typeof aiScores.$inferSelect) => iso(s);
const itemDto = ({ id, status, addedBy, createdAt }: typeof aiDatasetItems.$inferSelect) =>
  iso({ id, status, addedBy, createdAt });

// Scores averaged per call first, so a call with many reviews counts once per version.
const perCallScores = sql`(select call_id,
    avg(value) filter (where source = 'judge') as judge,
    avg(value) filter (where source = 'user') as "user"
  from ai_scores group by call_id)`;

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

  // LLM Ops (docs/adr/0009-llm-ops.md): per prompt version and per day, for the admin page.
  app.get(
    '/stats',
    {
      ...admin,
      schema: {
        tags,
        params: OrgParams,
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
        response: {
          200: z.object({ versions: z.array(VersionStats), days: z.array(DayStats) }),
          403: ErrorBody,
        },
      },
    },
    async (req) => {
      activeOrg(req, req.params.orgId);
      const since = new Date(Date.now() - req.query.days * 86_400_000);
      return withTenant(req, async (tx) => {
        const versions = await tx.execute(sql`
          select c.purpose, c.prompt_template_id as template,
            c.prompt_template_version as version, c.request_model as model,
            count(*)::int as calls, avg((c.status = 'error')::int)::float8 as "errorRate",
            avg(c.cost)::float8 as "avgCost", avg(c.latency_ms)::float8 as "avgLatencyMs",
            avg(s.judge)::float8 as "judgeScore", count(s.judge)::int as judged,
            avg(s."user")::float8 as "userScore", count(s."user")::int as reviewed
          from ai_calls c left join ${perCallScores} s on s.call_id = c.id
          where c.created_at >= ${since}
          group by 1, 2, 3, 4 order by 1, 2, 3 desc, 4`);
        const days = await tx.execute(sql`
          select to_char(date_trunc('day', c.created_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
            c.purpose, count(*)::int as calls, count(*) filter (where c.status = 'error')::int
            as errors, sum(c.cost)::float8 as cost, avg(s.judge)::float8 as "judgeScore",
            avg(s."user")::float8 as "userScore"
          from ai_calls c left join ${perCallScores} s on s.call_id = c.id
          where c.created_at >= ${since}
          group by 1, 2 order by 1, 2`);
        return {
          versions: versions.rows as z.infer<typeof VersionStats>[],
          days: days.rows as z.infer<typeof DayStats>[],
        };
      });
    },
  );

  app.get(
    '/:id',
    {
      ...admin,
      schema: {
        tags,
        params: CallParams,
        response: {
          200: AiCall.extend({
            scores: z.array(Score),
            datasetItem: DatasetItem.nullable(),
            traceUrl: z.string().nullable(),
          }),
          403: ErrorBody,
          404: ErrorBody,
        },
      },
    },
    async (req) => {
      activeOrg(req, req.params.orgId);
      return withTenant(req, async (tx) => {
        const [row] = await tx.select().from(aiCalls).where(eq(aiCalls.id, req.params.id));
        if (!row) throw httpError(404, 'not found');
        const scores = await tx
          .select()
          .from(aiScores)
          .where(eq(aiScores.callId, row.id))
          .orderBy(asc(aiScores.createdAt));
        const [item] = await tx
          .select()
          .from(aiDatasetItems)
          .where(eq(aiDatasetItems.callId, row.id));
        const traceUrl =
          row.traceId && env.TRACE_URL_TEMPLATE
            ? env.TRACE_URL_TEMPLATE.replace('{traceId}', row.traceId)
            : null;
        return {
          ...dto(row),
          scores: scores.map(scoreDto),
          datasetItem: item ? itemDto(item) : null,
          traceUrl,
        };
      });
    },
  );

  // Prompt and completion content. Can contain personal data: every read is audit-logged.
  app.get(
    '/:id/content',
    {
      ...admin,
      schema: {
        tags,
        params: CallParams,
        response: {
          200: z.object({ request: z.unknown(), response: z.unknown() }),
          403: ErrorBody,
          404: ErrorBody,
        },
      },
    },
    async (req) => {
      activeOrg(req, req.params.orgId);
      const row = await withTenant(req, async (tx) => {
        const [found] = await tx.select().from(aiCalls).where(eq(aiCalls.id, req.params.id));
        if (!found) throw httpError(404, 'not found');
        await tx.insert(auditLog).values({
          orgId: req.tenant.orgId,
          actorId: req.tenant.userId,
          action: 'ai_call.content_viewed',
          target: found.id,
          ip: req.ip,
        });
        return found;
      });
      const [request, response] = await Promise.all([
        getAiContent(row.requestKey),
        row.responseKey ? getAiContent(row.responseKey) : null,
      ]);
      return { request, response };
    },
  );

  // "Add to golden set": a pending item that `pnpm eval:pull` turns into a Promptfoo test case.
  app.post(
    '/:id/dataset',
    {
      ...admin,
      schema: {
        tags,
        params: CallParams,
        response: { 201: DatasetItem, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      activeOrg(req, req.params.orgId);
      const item = await withTenant(
        req,
        async (tx) => {
          const [found] = await tx.select().from(aiCalls).where(eq(aiCalls.id, req.params.id));
          if (!found) throw httpError(404, 'not found');
          if (found.status !== 'ok' || !found.responseKey) {
            throw httpError(409, 'only successful calls with stored output can be added');
          }
          const [created] = await tx
            .insert(aiDatasetItems)
            .values({
              orgId: req.tenant.orgId,
              callId: found.id,
              purpose: found.purpose,
              addedBy: req.tenant.userId,
            })
            .onConflictDoNothing()
            .returning();
          if (!created) throw httpError(409, 'already in the golden set');
          return created;
        },
        (i) => i.callId,
      );
      return reply.code(201).send(itemDto(item));
    },
  );
};
