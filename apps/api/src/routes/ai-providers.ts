import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { aiProviders } from '@app/db';
import { desc, eq } from 'drizzle-orm';
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireEntitlement } from '../billing/entitlements.ts';
import { env } from '../env.ts';
import { isEnabled } from '../flags.ts';
import { httpError, requireRole, withTenant } from '../tenant.ts';
import { encryptSecret } from '../webhook-secret.ts';

/**
 * AI providers an organization brings itself (docs/llm-providers.md "BYO"): its own API key for a
 * vendor or aggregator of config/ai-models.json, or a custom OpenAI-compatible endpoint, if the
 * current AI_CONTOUR lists that provider (the contour decides where data may go; the worker
 * checks it again at call time). Org admins only, plan feature `byoLlm`, feature flag
 * `byo-llm-providers` (off: 404). The key is encrypted at once (bound to org and row id) and
 * never returned; the worker's AI gateway decrypts it for this organization's calls only and
 * checks a custom base URL against private ranges at call time (AI_BYO_ALLOWED_CIDRS).
 */
const config = JSON.parse(
  readFileSync(new URL('../../../../config/ai-models.json', import.meta.url), 'utf8'),
) as {
  providers: Record<string, { kind: string }>;
  contours: Record<string, { provider: string; purposes: string[] }[]>;
};
const BYO_KINDS = new Set(['api', 'aggregator', 'custom']);
const kindOf = new Map(Object.entries(config.providers).map(([id, p]) => [id, p.kind]));
/** BYO-able providers the current contour lists, and its purposes (the judge is the operator's). */
const contour = () => {
  const models = config.contours[env.AI_CONTOUR] ?? [];
  const listed = new Set(models.map((m) => m.provider));
  return {
    providers: Object.entries(config.providers)
      .filter(([id, p]) => BYO_KINDS.has(p.kind) && listed.has(id))
      .map(([id, p]) => ({ id, kind: p.kind })),
    purposes: [...new Set(models.flatMap((m) => m.purposes))].filter((p) => p !== 'judge'),
  };
};

const url = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((u) => {
    const parsed = new URL(u);
    return !parsed.username && !parsed.password;
  }, 'credentials in the URL are not allowed');
const Models = z
  .record(z.string(), z.string().trim().min(1).max(200))
  .refine((m) => Object.keys(m).length > 0, 'at least one purpose')
  .refine((m) => Object.keys(m).every((p) => contour().purposes.includes(p)), 'unknown purpose');
const Fields = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: url.nullable().optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  models: Models,
  enabled: z.boolean().optional(),
});
const Create = Fields.extend({ provider: z.string() });
const Provider = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: z.string(),
  kind: z.string(),
  baseUrl: z.string().nullable(),
  apiKeyHint: z.string().nullable(),
  models: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const Options = z.object({
  providers: z.array(z.object({ id: z.string(), kind: z.string() })),
  purposes: z.array(z.string()),
});
const Id = z.object({ id: z.uuid() });
const ErrorBody = z.object({ error: z.string() });

type Row = typeof aiProviders.$inferSelect;
const dto = ({ orgId: _, apiKey: __, createdAt, updatedAt, ...p }: Row) => ({
  ...p,
  kind: kindOf.get(p.provider) ?? 'unknown',
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

/** Custom endpoints need a base URL; vendor providers have a fixed one and need a key. */
function checkShape(provider: string, baseUrl: string | null | undefined, hasKey: boolean) {
  const allowed = contour().providers;
  const kind = allowed.find((p) => p.id === provider)?.kind;
  if (!kind) {
    throw httpError(400, `provider must be one of: ${allowed.map((p) => p.id).join(', ')}`);
  }
  if (kind === 'custom' && !baseUrl) throw httpError(400, 'baseUrl is required for this provider');
  if (kind !== 'custom' && baseUrl) throw httpError(400, 'baseUrl is only for custom endpoints');
  if (kind !== 'custom' && !hasKey) throw httpError(400, 'apiKey is required for this provider');
}

const keyFields = (apiKey: string, orgId: string, id: string) => ({
  apiKey: encryptSecret(apiKey, `${orgId}/${id}`),
  apiKeyHint: apiKey.slice(-4),
});

export const aiProviderRoutes: FastifyPluginAsyncZod = async (app) => {
  const flag: preHandlerAsyncHookHandler = async (req) => {
    const { userId, orgId } = req.tenant;
    if (!(await isEnabled('byo-llm-providers', { userId, orgId })))
      throw httpError(404, 'not found');
  };
  const admin = [requireRole('admin'), flag];
  const write = { preHandler: [...admin, requireEntitlement('byoLlm')] };
  const tags = ['ai-providers'];

  app.get(
    '/options',
    { preHandler: admin, schema: { tags, response: { 200: Options } } },
    async () => contour(),
  );

  app.get(
    '/',
    { preHandler: admin, schema: { tags, response: { 200: z.array(Provider) } } },
    async (req) =>
      withTenant(req, async (tx) =>
        (await tx.select().from(aiProviders).orderBy(desc(aiProviders.createdAt))).map(dto),
      ),
  );

  app.post(
    '/',
    { ...write, schema: { tags, body: Create, response: { 201: Provider, 400: ErrorBody } } },
    async (req, reply) => {
      const { provider, baseUrl, apiKey, ...rest } = req.body;
      checkShape(provider, baseUrl, Boolean(apiKey));
      const id = randomUUID();
      const { orgId } = req.tenant;
      const row = await withTenant(
        req,
        async (tx) => {
          const [created] = await tx
            .insert(aiProviders)
            .values({
              id,
              orgId,
              provider,
              baseUrl: baseUrl ?? null,
              ...(apiKey && keyFields(apiKey, orgId, id)),
              ...rest,
            })
            .returning();
          return created!;
        },
        (p) => p.id,
      );
      return reply.code(201).send(dto(row));
    },
  );

  app.patch(
    '/:id',
    {
      ...write,
      schema: {
        tags,
        params: Id,
        body: Fields.partial(),
        response: { 200: Provider, 400: ErrorBody, 404: ErrorBody },
      },
    },
    async (req) =>
      withTenant(req, async (tx) => {
        const [current] = await tx
          .select()
          .from(aiProviders)
          .where(eq(aiProviders.id, req.params.id));
        if (!current) throw httpError(404, 'not found');
        const { apiKey, baseUrl, ...rest } = req.body;
        const nextBase = baseUrl === undefined ? current.baseUrl : baseUrl;
        checkShape(current.provider, nextBase, Boolean(apiKey ?? current.apiKey));
        const [updated] = await tx
          .update(aiProviders)
          .set({
            ...rest,
            baseUrl: nextBase,
            ...(apiKey && keyFields(apiKey, req.tenant.orgId, current.id)),
            updatedAt: new Date(),
          })
          .where(eq(aiProviders.id, current.id))
          .returning();
        return dto(updated!);
      }),
  );

  app.delete('/:id', { preHandler: admin, schema: { tags, params: Id } }, async (req, reply) => {
    await withTenant(req, async (tx) => {
      const [row] = await tx
        .delete(aiProviders)
        .where(eq(aiProviders.id, req.params.id))
        .returning({ id: aiProviders.id });
      if (!row) throw httpError(404, 'not found');
    });
    return reply.code(204).send();
  });
};
