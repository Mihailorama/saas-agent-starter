import { randomUUID } from 'node:crypto';
import { aiCalls, aiDatasetItems, aiScores, auditLog, projects, withOrg } from '@app/db';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { auth } from '../src/auth.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { exportPending } from '../src/eval-pull.ts';
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
    // SSO is off unless OIDC_* is set (tests run without it).
    expect((await app.inject('/api/auth-config')).json()).toEqual({ sso: false });
    // Langfuse feedback is off unless LANGFUSE_PUBLIC_URL/KEY are set.
    expect((await app.inject('/api/client-config')).json()).toEqual({ langfuse: null });
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
    const aiCall = await recordAiCall(org, { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16) });
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
      // For the browser's Langfuse feedback score (Full profile).
      aiTrace: { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16) },
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

    // Each review is a user score on the call: confirm = 1, correct = 0.
    const scores = await withOrg(db, org, (tx) => tx.select().from(aiScores));
    expect(scores.map((s) => [s.callId, s.source, s.name, s.value, s.actorId])).toEqual([
      [aiCall.id, 'user', 'review', 1, owner.id],
      [aiCall.id, 'user', 'review', 0, owner.id],
    ]);

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

describe('LLM Ops', () => {
  const s3 = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  const put = (key: string, doc: object) =>
    s3.send(
      new PutObjectCommand({ Bucket: env.AI_CONTENT_BUCKET, Key: key, Body: JSON.stringify(doc) }),
    );

  it('shows call detail, content (audited), scores, version stats and the golden set', async () => {
    await s3
      .send(new HeadBucketCommand({ Bucket: env.AI_CONTENT_BUCKET }))
      .catch(() => s3.send(new CreateBucketCommand({ Bucket: env.AI_CONTENT_BUCKET })));
    const owner = await signUp();
    const org = await createOrg(owner);
    const base = `/api/orgs/${org}/ai-calls`;
    const v1 = await recordAiCall(org, {
      requestKey: `${org}/v1/request.json`,
      responseKey: `${org}/v1/response.json`,
      traceId: 'a'.repeat(32),
    });
    const v2 = await recordAiCall(org, {
      promptTemplateVersion: '2',
      cost: 0.00004,
      responseKey: `${org}/v2/response.json`,
    });
    const failed = await recordAiCall(org, { status: 'error', responseKey: null, cost: null });
    await put(v1.requestKey, { messages: [{ role: 'user', content: 'Project: Apollo' }] });
    await put(v1.responseKey!, { text: 'A Moon landing.' });
    await withOrg(db, org, (tx) =>
      tx.insert(aiScores).values([
        { orgId: org, callId: v1.id, source: 'judge', name: 'quality', value: 0.5 },
        { orgId: org, callId: v1.id, source: 'user', name: 'review', value: 1 },
        { orgId: org, callId: v2.id, source: 'judge', name: 'quality', value: 0.9 },
      ]),
    );

    const detail = await call(owner, 'GET', `${base}/${v1.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: v1.id,
      datasetItem: null,
      scores: [
        { source: 'judge', name: 'quality', value: 0.5 },
        { source: 'user', name: 'review', value: 1 },
      ],
    });
    expect((await call(owner, 'GET', `${base}/${randomUUID()}`)).statusCode).toBe(404);

    const content = await call(owner, 'GET', `${base}/${v1.id}/content`);
    expect(content.json()).toEqual({
      request: { messages: [{ role: 'user', content: 'Project: Apollo' }] },
      response: { text: 'A Moon landing.' },
    });
    const missing = await call(owner, 'GET', `${base}/${v2.id}/content`); // expired objects
    expect(missing.json()).toEqual({ request: null, response: null });

    const stats = (await call(owner, 'GET', `${base}/stats?days=7`)).json();
    const byVersion = Object.fromEntries(
      stats.versions.map((v: { version: string }) => [v.version, v]),
    );
    expect(byVersion['1']).toMatchObject({
      template: 'project.summary',
      calls: 2,
      errorRate: 0.5,
      judgeScore: 0.5,
      judged: 1,
      userScore: 1,
      reviewed: 1,
    });
    expect(byVersion['2']).toMatchObject({ calls: 1, judgeScore: 0.9, avgCost: 0.00004 });
    expect(stats.days).toEqual([
      expect.objectContaining({ purpose: 'project.summary', calls: 3, errors: 1 }),
    ]);

    const add = (id: string) => call(owner, 'POST', `${base}/${id}/dataset`);
    const added = await add(v1.id);
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ status: 'pending', addedBy: owner.id });
    expect((await add(v1.id)).statusCode).toBe(409); // once per call
    expect((await add(failed.id)).statusCode).toBe(409); // no output to keep
    const items = await withOrg(db, org, (tx) => tx.select().from(aiDatasetItems));
    expect(items.map((i) => [i.callId, i.purpose, i.status])).toEqual([
      [v1.id, 'project.summary', 'pending'],
    ]);

    // eval:pull exports pending items as Promptfoo test cases, once.
    expect(await exportPending(org)).toEqual([
      {
        purpose: 'project.summary',
        test: {
          description: `call ${v1.id}`,
          vars: { input: 'Project: Apollo', recorded_output: 'A Moon landing.' },
          metadata: { callId: v1.id, model: 'claude-haiku-5-5', prompt: 'project.summary v1' },
        },
      },
    ]);
    expect(await exportPending(org)).toEqual([]);
    const [exported] = await withOrg(db, org, (tx) => tx.select().from(aiDatasetItems));
    expect(exported).toMatchObject({ status: 'exported', exportedAt: expect.any(Date) });

    const audit = await withOrg(db, org, (tx) => tx.select().from(auditLog));
    expect(audit.map((a) => [a.action, a.target])).toEqual(
      expect.arrayContaining([
        ['ai_dataset.exported', v1.id],
        ['ai_call.content_viewed', v1.id],
        ['POST /api/orgs/:orgId/ai-calls/:id/dataset', v1.id],
      ]),
    );

    // Admin only, active org only, tenant-isolated.
    const memberUser = await signUp();
    await auth.api.addMember({
      body: { userId: memberUser.id, organizationId: org, role: 'member' },
    });
    await call(memberUser, 'POST', '/api/auth/organization/set-active', { organizationId: org });
    for (const url of [`${base}/${v1.id}`, `${base}/${v1.id}/content`, `${base}/stats`]) {
      expect((await call(memberUser, 'GET', url)).statusCode).toBe(403);
    }
    expect((await call(memberUser, 'POST', `${base}/${v2.id}/dataset`)).statusCode).toBe(403);
    const stranger = await signUp();
    const other = await createOrg(stranger);
    expect((await call(stranger, 'GET', `${base}/${v1.id}`)).statusCode).toBe(403);
    expect((await call(stranger, 'GET', `/api/orgs/${other}/ai-calls/${v1.id}`)).statusCode).toBe(
      404,
    );
    expect((await call(stranger, 'GET', `/api/orgs/${other}/ai-calls/stats`)).json()).toEqual({
      versions: [],
      days: [],
    });
  });
});
