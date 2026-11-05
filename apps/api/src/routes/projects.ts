import { randomUUID } from 'node:crypto';
import { attachments, projects } from '@app/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { presignDownload, presignUpload } from '../s3.ts';
import { startProjectCreated } from '../temporal.ts';
import { httpError, requireRole, withTenant } from '../tenant.ts';

const Project = z.object({
  id: z.uuid(),
  name: z.string(),
  fingerprint: z.string().nullable(),
  createdAt: z.string(),
});
const ProjectInput = z.object({ name: z.string().trim().min(1).max(200) });
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
const projectDto = ({ orgId: _, ...p }: typeof projects.$inferSelect) => toDto(p);
const attachmentDto = ({ orgId: _, projectId: __, ...a }: typeof attachments.$inferSelect) =>
  toDto(a);
const objectKey = (a: { orgId: string; projectId: string; id: string }) =>
  `${a.orgId}/${a.projectId}/${a.id}`;

export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  const member = { preHandler: requireRole('member') };
  const tags = ['projects'];

  app.get('/', { ...member, schema: { tags, response: { 200: z.array(Project) } } }, async (req) =>
    withTenant(req, async (tx) =>
      (await tx.select().from(projects).orderBy(desc(projects.createdAt))).map(projectDto),
    ),
  );

  app.post(
    '/',
    { ...member, schema: { tags, body: ProjectInput, response: { 201: Project } } },
    async (req, reply) => {
      const project = await withTenant(
        req,
        async (tx) => {
          const [row] = await tx
            .insert(projects)
            .values({ orgId: req.tenant.orgId, name: req.body.name })
            .returning();
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
      }).catch((err) => req.log.error({ err }, 'failed to start ProjectCreatedWorkflow'));
      return reply.code(201).send(projectDto(project));
    },
  );

  app.get(
    '/:id',
    { ...member, schema: { tags, params: Id, response: { 200: Project, 404: ErrorBody } } },
    async (req) =>
      withTenant(req, async (tx) => {
        const [row] = await tx.select().from(projects).where(eq(projects.id, req.params.id));
        if (!row) throw httpError(404, 'not found');
        return projectDto(row);
      }),
  );

  app.patch(
    '/:id',
    { ...member, schema: { tags, params: Id, body: ProjectInput, response: { 200: Project } } },
    async (req) =>
      withTenant(req, async (tx) => {
        const [row] = await tx
          .update(projects)
          .set({ name: req.body.name })
          .where(eq(projects.id, req.params.id))
          .returning();
        if (!row) throw httpError(404, 'not found');
        return projectDto(row);
      }),
  );

  app.delete(
    '/:id',
    { preHandler: requireRole('admin'), schema: { tags, params: Id } },
    async (req, reply) => {
      await withTenant(req, async (tx) => {
        const [row] = await tx.delete(projects).where(eq(projects.id, req.params.id)).returning();
        if (!row) throw httpError(404, 'not found');
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/:id/attachments',
    { ...member, schema: { tags, params: Id, response: { 200: z.array(Attachment) } } },
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
      ...member,
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
      ...member,
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
