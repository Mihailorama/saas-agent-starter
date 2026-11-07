import { createHmac, randomUUID } from 'node:crypto';
import { aiCalls, auditLog, projects, withOrg } from '@app/db';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { auth } from '../src/auth.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { exportCalls } from '../src/eval-pull.ts';
import { ensureBucket } from '../src/s3.ts';
import {
  closeTemporal,
  projectWorkflowId,
  startProjectCreated,
  supportClosedWorkflowId,
  supportTriageWorkflowId,
  temporal,
} from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
// Unique client IP per call so the auth rate limit only bites where we want it.
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;

type User = { id: string; email: string; cookie: string };
const password = 'correct-horse-battery';
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

// Mails go out through the worker's SendEmailWorkflow into the compose Mailpit.
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';
type Mail = { Subject: string; Text: string; HTML: string; link: string };

/** The newest mail to `to` (optionally: whose subject matches), waiting for the worker. */
async function mailTo(to: string, subject?: RegExp): Promise<Mail> {
  for (let i = 0; i < 100; i++) {
    const query = new URLSearchParams({ query: `to:${to}` });
    const { messages } = await (await fetch(`${mailpit}/api/v1/search?${query}`)).json();
    const hit = messages.find((m: { Subject: string }) => !subject || subject.test(m.Subject));
    if (hit) {
      const mail = await (await fetch(`${mailpit}/api/v1/message/${hit.ID}`)).json();
      const link = mail.Text.match(/https?:\/\/[^\s\]]+/)?.[0];
      expect(mail.HTML).toContain(link.replaceAll('&', '&amp;'));
      return { ...mail, link };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail to ${to} in Mailpit: are Mailpit and the worker (pnpm worker) up?`);
}

/** Follows a mailed link through the API: path + query, same as the browser would. */
const follow = (link: string, cookie?: string) => {
  const url = new URL(link);
  return app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    remoteAddress: ip(),
    headers: cookie ? { cookie } : {},
  });
};

/** Signs up, confirms the address from the mailed link and returns the signed-in user. */
async function signUp(email = `${randomUUID()}@example.com`): Promise<User> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    remoteAddress: ip(),
    headers: { origin },
    payload: { email, password, name: 'T' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().token).toBeNull(); // no session before the address is confirmed
  const verified = await follow((await mailTo(email, /Confirm/)).link);
  expect(verified.statusCode).toBe(302);
  const cookie = cookieOf(verified);
  expect(cookie).toContain('session_token');
  return { id: res.json().user.id, email, cookie };
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

describe('transactional email', () => {
  const signIn = (email: string, pass: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: ip(),
      headers: { origin },
      payload: { email, password: pass },
    });

  it('verifies the address from the mailed link, in the requested language', async () => {
    const email = `${randomUUID()}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      remoteAddress: ip(),
      headers: { origin, 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' },
      payload: { email, password, name: 'Ада' },
    });
    expect(res.statusCode).toBe(200);
    expect((await signIn(email, password)).statusCode).toBe(403); // not verified yet

    const mail = await mailTo(email, /Подтвердите/);
    expect(mail.Text).toContain('Ада, подтвердите адрес почты');
    expect(mail.HTML).toContain('lang="ru"');
    const verified = await follow(mail.link);
    expect(verified.statusCode).toBe(302);
    const session = await call(
      { id: '', email, cookie: cookieOf(verified) },
      'GET',
      '/api/auth/get-session',
    );
    expect(session.json().user).toMatchObject({ email, emailVerified: true });
    expect((await signIn(email, password)).statusCode).toBe(200);
  });

  it('resets a forgotten password through the mailed link', async () => {
    const user = await signUp();
    const requested = await call(null, 'POST', '/api/auth/request-password-reset', {
      email: user.email,
      redirectTo: '/reset-password',
    });
    expect(requested.statusCode).toBe(200);
    // Unknown addresses get the same answer and no mail.
    const unknown = await call(null, 'POST', '/api/auth/request-password-reset', {
      email: `${randomUUID()}@example.com`,
      redirectTo: '/reset-password',
    });
    expect(unknown.json()).toEqual(requested.json());

    const mail = await mailTo(user.email, /Reset/);
    expect(mail.Text).toContain('Reset your password');
    // The link checks the token and lands on the web's reset page with it.
    const landing = await follow(mail.link);
    expect(landing.statusCode).toBe(302);
    const token = new URL(landing.headers.location!, origin).searchParams.get('token');
    expect(token).toBeTruthy();
    const reset = await call(null, 'POST', '/api/auth/reset-password', {
      newPassword: 'a-brand-new-passphrase',
      token,
    });
    expect(reset.statusCode).toBe(200);
    expect((await signIn(user.email, password)).statusCode).toBe(401);
    expect((await signIn(user.email, 'a-brand-new-passphrase')).statusCode).toBe(200);
    // Sessions from before the reset are revoked.
    expect((await call(user, 'GET', '/api/auth/get-session')).json()).toBeNull();
  });

  it('mails an organization invitation that the invitee accepts', async () => {
    const owner = await signUp();
    const org = await createOrg(owner);
    const inviteeEmail = `${randomUUID()}@example.com`;
    const invited = await call(owner, 'POST', '/api/auth/organization/invite-member', {
      email: inviteeEmail,
      role: 'member',
      organizationId: org,
    });
    expect(invited.statusCode).toBe(200);

    const mail = await mailTo(inviteeEmail, /invited you/);
    expect(mail.Subject).toBe('T invited you to Org');
    const invitationId = new URL(mail.link).pathname.split('/').at(-1);
    expect(mail.link).toBe(`${env.BETTER_AUTH_URL}/accept-invitation/${invitationId}`);

    const invitee = await signUp(inviteeEmail);
    const accepted = await call(invitee, 'POST', '/api/auth/organization/accept-invitation', {
      invitationId,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().member).toMatchObject({ organizationId: org, role: 'member' });
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
    const traceId = 'a'.repeat(32);
    const aiCall = await recordAiCall(org, { traceId });
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
      aiTraceId: traceId, // feedback scores attach to this trace (docs/product-analytics.md)
      reviewedBy: owner.id,
    });
    expect((await call(owner, 'GET', `/api/projects/${project.id}`)).json().aiTraceId).toBe(
      traceId,
    );

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

describe('PostHog webhook -> tracker item', () => {
  const hook = (secret: string | null, event: object) =>
    app.inject({
      method: 'POST',
      url: '/api/hooks/posthog',
      remoteAddress: ip(),
      headers: secret === null ? {} : { 'x-webhook-secret': secret },
      payload: { event },
    });
  const alert = {
    event: '$insight_alert_firing',
    properties: {
      alert_name: 'activation below 30%',
      insight_name: 'Journey: activation',
      insight_id: 'AbC123',
      state: 'Firing',
      breaches: 'The insight value (12%) is below the lower threshold (30%)',
    },
  };
  const survey = {
    event: 'survey sent',
    properties: {
      $survey_name: 'Report a problem',
      $survey_questions: [
        {
          id: 'q1',
          question: 'What went wrong?',
          response: 'Upload fails, mail me at a@example.com',
        },
      ],
      $pathname: '/projects/$projectId',
      release: 'abc123',
    },
  };

  it('needs the shared secret', async () => {
    expect((await hook(null, alert)).statusCode).toBe(401);
    expect((await hook('wrong', alert)).statusCode).toBe(401);
  });

  it('dry-runs without tracker credentials and ignores unrelated events', async () => {
    const secret = env.POSTHOG_WEBHOOK_SECRET!;
    const planned = (await hook(secret, alert)).json();
    expect(planned).toMatchObject({
      action: 'dry-run',
      producer: 'cjm-regression',
      title: '[cjm] activation below 30%',
    });
    expect(planned.body).toContain('below the lower threshold');
    const feedback = (await hook(secret, survey)).json();
    expect(feedback).toMatchObject({ action: 'dry-run', producer: 'from-users' });
    expect(feedback.body).not.toContain('a@example.com');
    expect((await hook(secret, { event: '$pageview', properties: {} })).json()).toEqual({
      action: 'ignored',
    });
    // Thumbs on AI answers stay in PostHog AI observability.
    const thumbs = { ...survey, properties: { ...survey.properties, $ai_trace_id: 't' } };
    expect((await hook(secret, thumbs)).json()).toEqual({ action: 'ignored' });
  });

  it('opens an item, then comments on it for the same alert (GitHub variant)', async () => {
    // The Plane default is covered against a fake server in tracker.test.ts.
    Object.assign(env, { TRACKER: 'github', GITHUB_TOKEN: 'test-token', GITHUB_REPO: 'o/app' });
    const issues: { number: number; title: string; html_url: string }[] = [];
    const calls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.pathname}`);
      expect(new Headers(init?.headers).get('authorization')).toBe('token test-token');
      if (method === 'GET') {
        expect(url.searchParams.get('labels')).toBe('cjm-regression');
        return Response.json(issues);
      }
      if (url.pathname.endsWith('/issues')) {
        const body = JSON.parse(String(init?.body));
        expect(body.labels).toEqual(['cjm-regression']);
        issues.push({
          number: 7,
          title: body.title,
          html_url: 'https://github.com/o/app/issues/7',
        });
        return Response.json(issues[0], { status: 201 });
      }
      return Response.json({}, { status: 201 });
    });
    try {
      const secret = env.POSTHOG_WEBHOOK_SECRET!;
      const item = { ref: '7', url: 'https://github.com/o/app/issues/7' };
      expect((await hook(secret, alert)).json()).toEqual({ action: 'created', ...item });
      expect((await hook(secret, alert)).json()).toEqual({ action: 'commented', ...item });
      expect(calls).toEqual([
        'GET /repos/o/app/issues',
        'POST /repos/o/app/issues',
        'GET /repos/o/app/issues',
        'POST /repos/o/app/issues/7/comments',
      ]);
    } finally {
      fetchMock.mockRestore();
      Object.assign(env, { TRACKER: 'plane', GITHUB_TOKEN: undefined, GITHUB_REPO: undefined });
    }
  });
});

describe('service desk (Chatwoot)', () => {
  const hex = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');
  const secrets = {
    CHATWOOT_WEBHOOK_SECRET: 'test-chatwoot-secret',
    CHATWOOT_HMAC_TOKEN: 'test-hmac-token',
    GITHUB_WEBHOOK_SECRET: 'test-github-secret',
    PLANE_WEBHOOK_SECRET: 'plane_wh_test',
    PLANE_PROJECT_ID: 'p1',
  };
  beforeAll(() => Object.assign(env, secrets));
  afterAll(() =>
    Object.assign(env, Object.fromEntries(Object.keys(secrets).map((k) => [k, undefined]))),
  );
  const post = (url: string, body: string, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      remoteAddress: ip(),
      headers: { 'content-type': 'application/json', ...headers },
      payload: body,
    });
  const chatwoot = (event: object, opts: { secret?: string; ts?: number } = {}) => {
    const body = JSON.stringify(event);
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const sig = `sha256=${hex(opts.secret ?? secrets.CHATWOOT_WEBHOOK_SECRET, `${ts}.${body}`)}`;
    return post('/api/hooks/chatwoot', body, {
      'x-chatwoot-signature': sig,
      'x-chatwoot-timestamp': ts,
    });
  };
  const message = (conversationId: number, extra: object = {}) => ({
    event: 'message_created',
    message_type: 'incoming',
    private: false,
    content: 'customer text',
    account: { id: 1 },
    conversation: { id: conversationId },
    ...extra,
  });

  it('checks the Chatwoot signature, its timestamp and the secret being set', async () => {
    const id = Math.floor(Math.random() * 1e9);
    expect((await chatwoot(message(id), { secret: 'wrong' })).statusCode).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 600;
    expect((await chatwoot(message(id), { ts: old })).statusCode).toBe(401); // replay
    const unsigned = await post('/api/hooks/chatwoot', JSON.stringify(message(id)), {});
    expect(unsigned.statusCode).toBe(401);
    // Signature over other bytes than the ones sent: rejected.
    const body = JSON.stringify(message(id));
    const ts = String(Math.floor(Date.now() / 1000));
    const forged = await post('/api/hooks/chatwoot', body.replace('1}', '2}'), {
      'x-chatwoot-signature': `sha256=${hex(secrets.CHATWOOT_WEBHOOK_SECRET, `${ts}.${body}`)}`,
      'x-chatwoot-timestamp': ts,
    });
    expect(forged.statusCode).toBe(401);
    env.CHATWOOT_WEBHOOK_SECRET = undefined;
    try {
      expect((await chatwoot(message(id))).statusCode).toBe(401); // no secret = disabled
    } finally {
      env.CHATWOOT_WEBHOOK_SECRET = secrets.CHATWOOT_WEBHOOK_SECRET;
    }
  });

  it('starts one triage workflow per conversation, only for customer messages', async () => {
    const c = { accountId: 1, conversationId: Math.floor(Math.random() * 1e9) };
    expect((await chatwoot(message(c.conversationId, { private: true }))).json()).toEqual({
      action: 'ignored',
    });
    const agent = message(c.conversationId, { message_type: 'outgoing' });
    expect((await chatwoot(agent)).json()).toEqual({ action: 'ignored' });
    expect((await chatwoot({ event: 'conversation_created' })).json()).toEqual({
      action: 'ignored',
    });

    expect((await chatwoot(message(c.conversationId))).json()).toEqual({ action: 'started' });
    expect((await chatwoot(message(c.conversationId))).json()).toEqual({ action: 'duplicate' });
    const handle = (await temporal()).workflow.getHandle(supportTriageWorkflowId(c));
    const run = await handle.describe();
    expect(run.type).toBe('SupportTriageWorkflow');
    // Ids only in Temporal's history: the worker reads the text from Chatwoot.
    expect(JSON.stringify(await handle.fetchHistory())).not.toContain('customer text');
    await handle.terminate('test cleanup');
  });

  it('starts the return path for closed GitHub issues with the support label', async () => {
    const issue = {
      number: Math.floor(Math.random() * 1e9),
      closed_at: '2026-11-07T10:00:00Z',
      labels: [{ name: 'support' }],
    };
    const github = (payload: object, event = 'issues', secret = secrets.GITHUB_WEBHOOK_SECRET) => {
      const body = JSON.stringify(payload);
      return post('/api/hooks/github', body, {
        'x-github-event': event,
        'x-hub-signature-256': `sha256=${hex(secret, body)}`,
      });
    };
    expect((await github({ action: 'closed', issue }, 'issues', 'wrong')).statusCode).toBe(401);
    const unlabelled = { action: 'closed', issue: { ...issue, labels: [] } };
    expect((await github(unlabelled)).json()).toEqual({ action: 'ignored' });
    expect((await github({ action: 'opened', issue })).json()).toEqual({ action: 'ignored' });
    expect((await github({ zen: 'hi' }, 'ping')).json()).toEqual({ action: 'ignored' });
    expect((await github({ action: 'closed', issue })).json()).toEqual({ action: 'started' });
    expect((await github({ action: 'closed', issue })).json()).toEqual({ action: 'duplicate' });
    const id = supportClosedWorkflowId(
      { tracker: 'github', issueId: String(issue.number) },
      String(Date.parse(issue.closed_at)),
    );
    const handle = (await temporal()).workflow.getHandle(id);
    expect((await handle.describe()).type).toBe('SupportIssueClosedWorkflow');
    await handle.terminate('test cleanup');

    // docs/releases.md: the "Released in vX.Y.Z" comment means the fix is live.
    const released = (body: string) => ({ action: 'created', issue, comment: { body } });
    const comment = 'Released in v1.2.0 (via #5). Release notes: https://example.com/r';
    expect((await github(released('thanks!'), 'issue_comment')).json()).toEqual({
      action: 'ignored',
    });
    expect((await github(released(comment), 'issue_comment')).json()).toEqual({
      action: 'started',
    });
    const rid = supportClosedWorkflowId(
      { tracker: 'github', issueId: String(issue.number) },
      'release-v1.2.0',
    );
    const rel = (await temporal()).workflow.getHandle(rid);
    expect(JSON.stringify(await rel.fetchHistory())).toContain('v1.2.0');
    await rel.terminate('test cleanup');
  });

  it('starts the return path for Plane state changes in our project', async () => {
    const plane = (payload: object, secret = secrets.PLANE_WEBHOOK_SECRET) => {
      const body = JSON.stringify(payload);
      return post('/api/hooks/plane', body, { 'x-plane-signature': hex(secret, body) });
    };
    const event = {
      event: 'workitem.updated',
      event_id: randomUUID(),
      entity_type: 'issue',
      data: { id: randomUUID(), project_id: 'p1' },
      previous_attributes: { state_id: 'old-state' },
    };
    expect((await plane(event, 'wrong')).statusCode).toBe(401);
    const other = { ...event, data: { ...event.data, project_id: 'p2' } };
    expect((await plane(other)).json()).toEqual({ action: 'ignored' });
    const renamed = { ...event, previous_attributes: { name: 'x' } };
    expect((await plane(renamed)).json()).toEqual({ action: 'ignored' });
    expect((await plane(event)).json()).toEqual({ action: 'started' });
    const id = supportClosedWorkflowId(
      { tracker: 'plane', issueId: event.data.id },
      event.event_id,
    );
    await (await temporal()).workflow.getHandle(id).terminate('test cleanup');

    // The release comment (scripts/released.mjs) on a Plane item: live in that version.
    const comment = (text: string) => ({
      event: 'workitem.comment.created',
      event_id: randomUUID(),
      entity_type: 'issue',
      data: { id: event.data.id, name: 'x', comment: { comment_stripped: text } },
      previous_attributes: {},
    });
    expect((await plane(comment('thanks!'))).json()).toEqual({ action: 'ignored' });
    expect((await plane(comment('Released in v1.2.0 (via #5). Notes'))).json()).toEqual({
      action: 'started',
    });
    const rid = supportClosedWorkflowId(
      { tracker: 'plane', issueId: event.data.id },
      'release-v1.2.0',
    );
    const rel = (await temporal()).workflow.getHandle(rid);
    expect(JSON.stringify(await rel.fetchHistory())).toContain('v1.2.0');
    await rel.terminate('test cleanup');

    // v1 payloads (Plane Community Edition, no `version`): the same two triggers.
    const v1Id = randomUUID();
    const v1 = (e: object) => plane({ webhook_id: 'w', workspace_slug: 'ws', ...e });
    const v1State = {
      event: 'issue',
      action: 'updated',
      data: { id: v1Id, project: 'p1', updated_at: '2026-11-07T10:00:00Z' },
      activity: { field: 'state_id', old_value: 'a', new_value: 'b' },
    };
    expect((await v1({ ...v1State, activity: { field: 'name' } })).json()).toEqual({
      action: 'ignored',
    });
    expect((await v1(v1State)).json()).toEqual({ action: 'started' });
    await (await temporal()).workflow
      .getHandle(
        supportClosedWorkflowId({ tracker: 'plane', issueId: v1Id }, v1State.data.updated_at),
      )
      .terminate('test cleanup');
    const v1Comment = {
      event: 'issue_comment',
      action: 'created',
      data: {
        id: randomUUID(),
        issue: v1Id,
        project: 'p1',
        comment_stripped: 'Released in v2.0.0 (via #9).',
      },
      activity: { field: null },
    };
    expect((await v1(v1Comment)).json()).toEqual({ action: 'started' });
    await (await temporal()).workflow
      .getHandle(supportClosedWorkflowId({ tracker: 'plane', issueId: v1Id }, 'release-v2.0.0'))
      .terminate('test cleanup');
  });

  it('signs the widget identity of the signed-in user only', async () => {
    expect((await call(null, 'GET', '/api/support/identity')).statusCode).toBe(401);
    const user = await signUp();
    const orgId = await createOrg(user);
    const res = await call(user, 'GET', '/api/support/identity');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      identifier: user.id,
      identifierHash: hex(secrets.CHATWOOT_HMAC_TOKEN, user.id),
      orgId,
    });
    env.CHATWOOT_HMAC_TOKEN = undefined;
    try {
      expect((await call(user, 'GET', '/api/support/identity')).statusCode).toBe(404);
    } finally {
      env.CHATWOOT_HMAC_TOKEN = secrets.CHATWOOT_HMAC_TOKEN;
    }
  });
});

describe('eval:pull', () => {
  it('exports logged calls of one purpose as Promptfoo cases, audit-logged', async () => {
    const s3 = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
    const put = (key: string, doc: object) =>
      s3.send(
        new PutObjectCommand({
          Bucket: env.AI_CONTENT_BUCKET,
          Key: key,
          Body: JSON.stringify(doc),
        }),
      );
    await s3
      .send(new HeadBucketCommand({ Bucket: env.AI_CONTENT_BUCKET }))
      .catch(() => s3.send(new CreateBucketCommand({ Bucket: env.AI_CONTENT_BUCKET })));
    const owner = await signUp();
    const org = await createOrg(owner);
    const ok = await recordAiCall(org, {
      requestKey: `${org}/ok/request.json`,
      responseKey: `${org}/ok/response.json`,
      promptTemplateId: 'project.summary/system',
    });
    const expired = await recordAiCall(org, { responseKey: `${org}/gone/response.json` });
    await recordAiCall(org, { status: 'error', responseKey: null });
    await recordAiCall(org, { purpose: 'other.purpose' });
    await put(ok.requestKey, {
      messages: [
        { role: 'system', content: 'Summarize.' },
        { role: 'user', content: 'Project: Apollo' },
      ],
    });
    await put(ok.responseKey!, { text: 'A Moon landing.' });

    const cases = await exportCalls(org, { purpose: 'project.summary' });
    expect(cases).toEqual([
      {
        description: `call ${ok.id}`,
        vars: { input: 'Project: Apollo', recorded_output: 'A Moon landing.' },
        metadata: {
          callId: ok.id,
          model: 'claude-haiku-5-5',
          prompt: 'project.summary/system v1',
        },
      },
    ]); // the expired call is skipped, the failed one and other purposes are not selected
    expect(await exportCalls(org, { purpose: 'project.summary', callIds: [expired.id] })).toEqual(
      [],
    );
    const audit = await withOrg(db, org, (tx) => tx.select().from(auditLog));
    expect(audit.map((a) => [a.action, a.target, a.actorId])).toContainEqual([
      'ai_call.exported_for_eval',
      ok.id,
      'eval:pull',
    ]);

    // Tenant isolation: another org exports nothing of this one.
    const stranger = await signUp();
    expect(await exportCalls(await createOrg(stranger), { purpose: 'project.summary' })).toEqual(
      [],
    );
  });
});
