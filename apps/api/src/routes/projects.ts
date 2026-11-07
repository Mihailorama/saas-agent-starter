import { randomUUID } from 'node:crypto';
import { aiCalls, attachments, projects, type Tx } from '@app/db';
import { and, count, desc, eq, getTableColumns } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireEntitlement } from '../billing/entitlements.ts';
import { publishEvent } from '../events.ts';
import { presignDownload, presignUpload } from '../s3.ts';
import { startProjectCreated } from '../temporal.ts';
import { access, httpError, withTenant } from '../tenant.ts';

const Project = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  fingerprint: z.string().nullable(),
  aiSummary: z.string().nullable(),
  aiStatus: z.enum(['generated', 'confirmed', 'corrected']).nullable(),
  aiCallId: z.uuid().nullable(),
  /** Trace id of the AI call; user feedback scores attach to it (docs/product-analytics.md). */
  aiTraceId: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
const ProjectInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});
const SummaryCorrection = z.object({ summary: z.string().trim().min(1).max(1000) });
const Attachment = z.object({
  id: z.uuid(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  createdAt: z.string(),
});
const AttachmentInput = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(127),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
});
const Id = z.object({ id: z.uuid() });
const ErrorBody = z.object({ error: z.string() });

const toDto = <T extends { createdAt: Date }>({ createdAt, ...rest }: T) => ({
  ...rest,
  createdAt: createdAt.toISOString(),
});
type ProjectRow = typeof projects.$inferSelect & { aiTraceId?: string | null };
const projectDto = ({ orgId: _, reviewedAt, aiTraceId, ...p }: ProjectRow) =>
  toDto({ ...p, aiTraceId: aiTraceId ?? null, reviewedAt: reviewedAt?.toISOString() ?? null });
/** Projects with the trace id of their AI call (same tenant, RLS applies to both tables). */
const selectProjects = (tx: Tx) =>
  tx
    .select({ ...getTableColumns(projects), aiTraceId: aiCalls.traceId })
    .from(projects)
    .leftJoin(aiCalls, eq(aiCalls.id, projects.aiCallId));
const loadProject = async (tx: Tx, id: string) =>
  (await selectProjects(tx).where(eq(projects.id, id)))[0];
const attachmentDto = ({
  orgId: _,
  projectId: __,
  createdBy: ___,
  ...a
}: typeof attachments.$inferSelect) => toDto(a);
const objectKey = (a: { orgId: string; projectId: string; id: string }) =>
  `${a.orgId}/${a.projectId}/${a.id}`;

export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = access('projects:read');
  const write = access('projects:write');
  const tags = ['projects'];

  app.get('/', { ...read, schema: { tags, response: { 200: z.array(Project) } } }, async (req) =>
    withTenant(req, async (tx) =>
      (await selectProjects(tx).orderBy(desc(projects.createdAt))).map(projectDto),
    ),
  );

  const projectLimit = requireEntitlement('projects', async (tx) => {
    const [row] = await tx.select({ n: count() }).from(projects);
    return row?.n ?? 0;
  });
  app.post(
    '/',
    {
      config: write.config,
      // After the scope check, so the limit applies in the API key's org as well.
      preHandler: [write.preHandler, projectLimit],
      schema: { tags, body: ProjectInput, response: { 201: Project, 402: ErrorBody } },
    },
    async (req, reply) => {
      const project = await withTenant(
        req,
        async (tx) => {
          const [row] = await tx
            .insert(projects)
            .values({
              orgId: req.tenant.orgId,
              name: req.body.name,
              description: req.body.description || null,
            })
            .returning();
          await publishEvent(req, tx, 'project.created', projectDto(row!));
          return row!;
        },
        (p) => p.id,
      );
      // Started after commit so the worker always finds the row.
      // ponytail: lost if Temporal is down at this instant; use an outbox table if that matters.
      await startProjectCreated({
        orgId: project.orgId,
        projectId: project.id,
        name: project.name,
        actorId: req.tenant.userId,
      }).catch((err) => req.log.error({ err }, 'failed to start ProjectCreatedWorkflow'));
      return reply.code(201).send(projectDto(project));
    },
  );

  app.get(
    '/:id',
    { ...read, schema: { tags, params: Id, response: { 200: Project, 404: ErrorBody } } },
    async (req) =>
      withTenant(req, async (tx) => {
        const row = await loadProject(tx, req.params.id);
        if (!row) throw httpError(404, 'not found');
        return projectDto(row);
      }),
  );

  app.patch(
    '/:id',
    { ...write, schema: { tags, params: Id, body: ProjectInput, response: { 200: Project } } },
    async (req) =>
      withTenant(req, async (tx) => {
        const [row] = await tx
          .update(projects)
          .set({
            name: req.body.name,
            ...(req.body.description !== undefined && {
              description: req.body.description || null,
            }),
          })
          .where(eq(projects.id, req.params.id))
          .returning({ id: projects.id });
        if (!row) throw httpError(404, 'not found');
        const project = projectDto((await loadProject(tx, row.id))!);
        await publishEvent(req, tx, 'project.updated', project);
        return project;
      }),
  );

  // Human oversight of the AI summary: confirm it as is, or replace it with a correction.
  // The original model output stays in ai_calls + S3; both actions are audit-logged.
  const reviewSummary = (req: FastifyRequest, id: string, summary?: string) =>
    withTenant(req, async (tx) => {
      const [current] = await tx
        .select({ aiSummary: projects.aiSummary })
        .from(projects)
        .where(eq(projects.id, id));
      if (!current) throw httpError(404, 'not found');
      if (current.aiSummary === null) throw httpError(409, 'no AI summary to review');
      await tx
        .update(projects)
        .set({
          aiStatus: summary === undefined ? 'confirmed' : 'corrected',
          reviewedBy: req.tenant.userId,
          reviewedAt: new Date(),
          ...(summary !== undefined && { aiSummary: summary }),
        })
        .where(eq(projects.id, id));
      const project = projectDto((await loadProject(tx, id))!);
      await publishEvent(req, tx, 'project.summary_reviewed', project);
      return project;
    });
  const reviewResponses = { 200: Project, 404: ErrorBody, 409: ErrorBody };

  app.post(
    '/:id/ai-summary/confirm',
    { ...write, schema: { tags, params: Id, response: reviewResponses } },
    async (req) => reviewSummary(req, req.params.id),
  );

  app.post(
    '/:id/ai-summary/correct',
    { ...write, schema: { tags, params: Id, body: SummaryCorrection, response: reviewResponses } },
    async (req) => reviewSummary(req, req.params.id, req.body.summary),
  );

  app.delete(
    '/:id',
    { ...access('projects:delete'), schema: { tags, params: Id } },
    async (req, reply) => {
      await withTenant(req, async (tx) => {
        const [row] = await tx.delete(projects).where(eq(projects.id, req.params.id)).returning();
        if (!row) throw httpError(404, 'not found');
        await publishEvent(req, tx, 'project.deleted', { id: row.id });
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/:id/attachments',
    { ...read, schema: { tags, params: Id, response: { 200: z.array(Attachment) } } },
    async (req) =>
      withTenant(req, async (tx) =>
        (
          await tx
            .select()
            .from(attachments)
            .where(eq(attachments.projectId, req.params.id))
            .orderBy(desc(attachments.createdAt))
        ).map(attachmentDto),
      ),
  );

  app.post(
    '/:id/attachments',
    {
      ...write,
      schema: {
        tags,
        params: Id,
        body: AttachmentInput,
        response: { 201: z.object({ attachment: Attachment, uploadUrl: z.url() }) },
      },
    },
    async (req, reply) => {
      const row = await withTenant(
        req,
        async (tx) => {
          const [project] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, req.params.id));
          if (!project) throw httpError(404, 'not found');
          const [created] = await tx
            .insert(attachments)
            .values({
              id: randomUUID(),
              orgId: req.tenant.orgId,
              projectId: project.id,
              createdBy: req.tenant.userId,
              ...req.body,
            })
            .returning();
          return created!;
        },
        (a) => a.id,
      );
      const uploadUrl = await presignUpload(objectKey(row), row.contentType, row.size);
      return reply.code(201).send({ attachment: attachmentDto(row), uploadUrl });
    },
  );

  app.get(
    '/:id/attachments/:attachmentId/download',
    {
      ...read,
      schema: {
        tags,
        params: Id.extend({ attachmentId: z.uuid() }),
        response: { 200: z.object({ url: z.url() }) },
      },
    },
    async (req) => {
      const row = await withTenant(req, async (tx) => {
        const [found] = await tx
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.id, req.params.attachmentId),
              eq(attachments.projectId, req.params.id),
            ),
          );
        if (!found) throw httpError(404, 'not found');
        return found;
      });
      return { url: await presignDownload(objectKey(row), row.filename) };
    },
  );
};
