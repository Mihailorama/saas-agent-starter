import { randomUUID } from 'node:crypto';
import { aiCalls, auditLog, projects, withOrg } from '@app/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { auth } from '../src/auth.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
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

describe('PostHog webhook -> GitHub issue', () => {
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

  it('dry-runs without a GitHub token and ignores unrelated events', async () => {
    const secret = env.POSTHOG_WEBHOOK_SECRET!;
    const planned = (await hook(secret, alert)).json();
    expect(planned).toMatchObject({
      action: 'dry-run',
      label: 'cjm-regression',
      title: '[cjm] activation below 30%',
    });
    expect(planned.body).toContain('below the lower threshold');
    const feedback = (await hook(secret, survey)).json();
    expect(feedback).toMatchObject({ action: 'dry-run', label: 'from-users' });
    expect(feedback.body).not.toContain('a@example.com');
    expect((await hook(secret, { event: '$pageview', properties: {} })).json()).toEqual({
      action: 'ignored',
    });
    // Thumbs on AI answers stay in PostHog AI observability.
    const thumbs = { ...survey, properties: { ...survey.properties, $ai_trace_id: 't' } };
    expect((await hook(secret, thumbs)).json()).toEqual({ action: 'ignored' });
  });

  it('opens an issue, then comments on it for the same alert', async () => {
    Object.assign(env, { GITHUB_TOKEN: 'test-token', GITHUB_REPO: 'example/app' });
    const issues: { number: number; title: string }[] = [];
    const calls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(
        `${init?.method ?? 'GET'} ${url.replace('https://api.github.com/repos/example/app', '')}`,
      );
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      if (init?.method === 'POST' && url.endsWith('/issues')) {
        const body = JSON.parse(String(init.body));
        expect(body.labels).toEqual(['cjm-regression']);
        issues.push({ number: 7, title: body.title });
        return Response.json({ number: 7 }, { status: 201 });
      }
      if (init?.method === 'POST') return Response.json({}, { status: 201 });
      return Response.json(issues);
    });
    try {
      const secret = env.POSTHOG_WEBHOOK_SECRET!;
      expect((await hook(secret, alert)).json()).toEqual({ action: 'created', issue: 7 });
      expect((await hook(secret, alert)).json()).toEqual({ action: 'commented', issue: 7 });
      expect(calls).toEqual([
        'GET /issues?state=open&per_page=100&labels=cjm-regression',
        'POST /issues',
        'GET /issues?state=open&per_page=100&labels=cjm-regression',
        'POST /issues/7/comments',
      ]);
    } finally {
      fetchMock.mockRestore();
      Object.assign(env, { GITHUB_TOKEN: undefined, GITHUB_REPO: undefined });
    }
  });
});
