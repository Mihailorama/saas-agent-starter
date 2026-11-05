import { randomUUID } from 'node:crypto';
import { aiCalls, auditLog, projects, withOrg } from '@app/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { auth } from '../src/auth.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins } from '../src/env.ts';
import { ensureBucket } from '../src/s3.ts';
import {
  closeTemporal,
  projectWorkflowId,
  startProjectCreated,
  temporal,
} from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
// Unique client IP per call so the auth rate limit only bites where we want it.
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;

type User = { id: string; cookie: string };

async function signUp(): Promise<User> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    remoteAddress: ip(),
    headers: { origin },
    payload: { email: `${randomUUID()}@example.com`, password: 'correct-horse-battery', name: 'T' },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return { id: res.json().user.id, cookie };
}

async function createOrg(user: User): Promise<string> {
  const slug = randomUUID();
  const res = await call(user, 'POST', '/api/auth/organization/create', { name: 'Org', slug });
  expect(res.statusCode).toBe(200);
  return res.json().id;
}

function call(
  user: User | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, ...(user && { cookie: user.cookie }) },
    ...(payload && { payload }),
  });
}

beforeAll(() => ensureBucket());
afterAll(async () => {
  await app.close();
  await closeTemporal();
  await pool.end();
});

describe('platform', () => {
  it('serves health, OpenAPI and security headers', async () => {
    const health = await app.inject('/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.headers['strict-transport-security']).toBeDefined();
    expect(health.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    const spec = (await app.inject('/openapi.json')).json();
    expect(Object.keys(spec.paths)).toContain('/api/projects/');
  });

  it('rejects anonymous and cross-origin requests', async () => {
    expect((await call(null, 'GET', '/api/projects')).statusCode).toBe(401);
    const evil = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { origin: 'https://evil.example.com' },
      payload: { name: 'x' },
    });
    expect(evil.statusCode).toBe(403);
  });

  it('rate limits sign-in attempts', async () => {
    const remoteAddress = ip();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress,
        headers: { origin },
        payload: { email: 'nobody@example.com', password: 'wrong-password-123' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('projects', () => {
  it('CRUD with tenant isolation, RBAC and audit log', async () => {
    const owner = await signUp();
    const orgA = await createOrg(owner);

    expect((await call(owner, 'POST', '/api/projects', { name: '' })).statusCode).toBe(400);
    const created = await call(owner, 'POST', '/api/projects', { name: 'Apollo' });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect((await call(owner, 'GET', '/api/projects')).json()).toEqual([project]);
    const renamed = await call(owner, 'PATCH', `/api/projects/${project.id}`, { name: 'Artemis' });
    expect(renamed.json().name).toBe('Artemis');

    // Another tenant sees nothing.
    const stranger = await signUp();
    await createOrg(stranger);
    expect((await call(stranger, 'GET', '/api/projects')).json()).toEqual([]);
    expect((await call(stranger, 'GET', `/api/projects/${project.id}`)).statusCode).toBe(404);
    expect((await call(stranger, 'DELETE', `/api/projects/${project.id}`)).statusCode).toBe(404); // RLS hides it

    // A plain member can read but not delete.
    const memberUser = await signUp();
    await auth.api.addMember({
      body: { userId: memberUser.id, organizationId: orgA, role: 'member' },
    });
    await call(memberUser, 'POST', '/api/auth/organization/set-active', { organizationId: orgA });
    expect((await call(memberUser, 'GET', '/api/projects')).json()).toHaveLength(1);
    expect((await call(memberUser, 'DELETE', `/api/projects/${project.id}`)).statusCode).toBe(403);

    expect((await call(owner, 'DELETE', `/api/projects/${project.id}`)).statusCode).toBe(204);

    const audit = await withOrg(db, orgA, (tx) => tx.select().from(auditLog));
    expect(audit.map((a) => [a.action, a.target, a.actorId])).toEqual(
      expect.arrayContaining([
        ['POST /api/projects', project.id, owner.id],
        ['PATCH /api/projects/:id', project.id, owner.id],
        ['DELETE /api/projects/:id', project.id, owner.id],
      ]),
    );
    expect(audit).toHaveLength(3); // rejected requests leave no audit rows
  });

  it('starts one Temporal workflow per project, idempotently', async () => {
    const owner = await signUp();
    await createOrg(owner);
    const project = (await call(owner, 'POST', '/api/projects', { name: 'Gemini' })).json();

    const handle = (await temporal()).workflow.getHandle(projectWorkflowId(project.id));
    const first = await handle.describe();
    expect(first.type).toBe('ProjectCreatedWorkflow');

    // Re-starting with the same id is a no-op, not a second execution.
    await startProjectCreated({
      orgId: 'x',
      projectId: project.id,
      name: 'Gemini',
      actorId: null,
    });
    expect((await handle.describe()).runId).toBe(first.runId);
    await handle.terminate('test cleanup');
  });

  it('uploads and downloads attachments through presigned URLs', async () => {
    const owner = await signUp();
    await createOrg(owner);
    const project = (await call(owner, 'POST', '/api/projects', { name: 'Mercury' })).json();
    const body = 'hello attachment';

    const created = await call(owner, 'POST', `/api/projects/${project.id}/attachments`, {
      filename: 'note.txt',
      contentType: 'text/plain',
      size: body.length,
    });
    expect(created.statusCode).toBe(201);
    const { attachment, uploadUrl } = created.json();
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body,
      headers: { 'content-type': 'text/plain' },
    });
    expect(put.status, await put.text()).toBe(200);

    const list = await call(owner, 'GET', `/api/projects/${project.id}/attachments`);
    expect(list.json()).toEqual([attachment]);
    const { url } = (
      await call(owner, 'GET', `/api/projects/${project.id}/attachments/${attachment.id}/download`)
    ).json();
    expect(await (await fetch(url)).text()).toBe(body);
  });
});

// What the worker's ai.call_llm writes; the API only reads it.
async function recordAiCall(orgId: string, over: Partial<typeof aiCalls.$inferInsert> = {}) {
  const [row] = await withOrg(db, orgId, (tx) =>
    tx
      .insert(aiCalls)
      .values({
        orgId,
        purpose: 'project.summary',
        provider: 'anthropic',
        requestModel: 'claude-haiku-5-5',
        responseModel: 'claude-haiku-5-5',
        promptTemplateId: 'project.summary',
        promptTemplateVersion: '1',
        requestKey: `${orgId}/x/request.json`,
        contentExpiresAt: new Date(Date.now() + 86_400_000),
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cost: 0.00002,
        costCurrency: 'USD',
        latencyMs: 420,
        status: 'ok',
        contour: 'eu',
        ...over,
      })
      .returning(),
  );
  return row!;
}

describe('AI summary review', () => {
  it('confirms or corrects an AI summary, audit-logged, tenant-isolated', async () => {
    const owner = await signUp();
    const org = await createOrg(owner);
    const created = await call(owner, 'POST', '/api/projects', {
      name: 'Apollo',
      description: 'Land on the Moon.',
    });
    const project = created.json();
    expect(project).toMatchObject({ description: 'Land on the Moon.', aiStatus: null });

    // Nothing generated yet.
    const early = await call(owner, 'POST', `/api/projects/${project.id}/ai-summary/confirm`);
    expect(early.statusCode).toBe(409);

    // The worker stores a summary (simulated here).
    const aiCall = await recordAiCall(org);
    await withOrg(db, org, (tx) =>
      tx
        .update(projects)
        .set({ aiSummary: 'A Moon landing.', aiStatus: 'generated', aiCallId: aiCall.id })
        .where(eq(projects.id, project.id)),
    );

    const confirmed = await call(owner, 'POST', `/api/projects/${project.id}/ai-summary/confirm`);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      aiSummary: 'A Moon landing.',
      aiStatus: 'confirmed',
      aiCallId: aiCall.id,
      reviewedBy: owner.id,
    });

    const url = `/api/projects/${project.id}/ai-summary/correct`;
    expect((await call(owner, 'POST', url, { summary: '  ' })).statusCode).toBe(400);
    const corrected = await call(owner, 'POST', url, { summary: 'Crewed lunar landing.' });
    expect(corrected.json()).toMatchObject({
      aiSummary: 'Crewed lunar landing.',
      aiStatus: 'corrected',
    });

    const stranger = await signUp();
    await createOrg(stranger);
    expect((await call(stranger, 'POST', url, { summary: 'x' })).statusCode).toBe(404);
    expect((await call(null, 'POST', url, { summary: 'x' })).statusCode).toBe(401);

    const audit = await withOrg(db, org, (tx) => tx.select().from(auditLog));
    expect(audit.map((a) => [a.action, a.target, a.actorId])).toEqual(
      expect.arrayContaining([
        ['POST /api/projects/:id/ai-summary/confirm', project.id, owner.id],
        ['POST /api/projects/:id/ai-summary/correct', project.id, owner.id],
      ]),
    );
  });
});

describe('AI calls log', () => {
  it('lists, filters, pages and exports for org admins only', async () => {
    const owner = await signUp();
    const org = await createOrg(owner);
    const ok = await recordAiCall(org);
    const failed = await recordAiCall(org, {
      status: 'error',
      errorClass: 'RateLimitError',
      requestModel: 'claude-sonnet-5-5',
      responseModel: null,
      responseKey: null,
    });
    const base = `/api/orgs/${org}/ai-calls`;

    const all = (await call(owner, 'GET', base)).json();
    expect(all.total).toBe(2);
    expect(all.items.map((c: { id: string }) => c.id)).toEqual([failed.id, ok.id]);
    expect(all.items[1]).toMatchObject({ cost: 0.00002, inputTokens: 100, contour: 'eu' });
    expect(all.items[0]).not.toHaveProperty('orgId');

    const errors = (await call(owner, 'GET', `${base}?status=error`)).json();
    expect(errors.items.map((c: { id: string }) => c.id)).toEqual([failed.id]);
    const byModel = (await call(owner, 'GET', `${base}?model=claude-haiku-5-5`)).json();
    expect(byModel.total).toBe(1);
    const paged = (await call(owner, 'GET', `${base}?limit=1&offset=1`)).json();
    expect(paged).toMatchObject({ total: 2, items: [{ id: ok.id }] });
    const future = (await call(owner, 'GET', `${base}?from=2999-01-01`)).json();
    expect(future.total).toBe(0);
    expect((await call(owner, 'GET', `${base}?status=maybe`)).statusCode).toBe(400);

    const exported = await call(owner, 'GET', `${base}/export?purpose=project.summary`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/x-ndjson');
    expect(exported.headers['content-disposition']).toMatch(/attachment; filename="ai-calls-/);
    const lines = exported.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([ok.id, failed.id]);

    // Members cannot read the log; other orgs cannot address it.
    const memberUser = await signUp();
    await auth.api.addMember({
      body: { userId: memberUser.id, organizationId: org, role: 'member' },
    });
    await call(memberUser, 'POST', '/api/auth/organization/set-active', { organizationId: org });
    expect((await call(memberUser, 'GET', base)).statusCode).toBe(403);
    expect((await call(memberUser, 'GET', `${base}/export`)).statusCode).toBe(403);
    const stranger = await signUp();
    await createOrg(stranger);
    expect((await call(stranger, 'GET', base)).statusCode).toBe(403);
    expect((await call(null, 'GET', base)).statusCode).toBe(401);
  });
});
