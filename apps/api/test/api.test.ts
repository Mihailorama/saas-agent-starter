import { createHmac, randomUUID } from 'node:crypto';
import { aiCalls, auditLog, projects, verification, withOrg } from '@app/db';
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
import { ensureBucket, getJson } from '../src/s3.ts';
import { DISPOSABLE_EMAIL } from '../src/signup-guard.ts';
import {
  closeTemporal,
  projectWorkflowId,
  startProjectCreated,
  supportClosedWorkflowId,
  supportTriageWorkflowId,
  temporal,
} from '../src/temporal.ts';
import { historyText } from './history.ts';
import { codeSignIn, signUp as codeSignUp, cookieOf } from './sign-in.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
// Unique client IP per call so the auth rate limit only bites where we want it.
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;

type User = { id: string; email: string; cookie: string };

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
      if (link) expect(mail.HTML).toContain(link.replaceAll('&', '&amp;'));
      return { ...mail, link };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail to ${to} in Mailpit: are Mailpit and the worker (pnpm worker) up?`);
}

const signUp = (email?: string): Promise<User> => codeSignUp(app, email);

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
        url: '/api/auth/sign-in/email-otp',
        remoteAddress,
        headers: { origin },
        payload: { email: 'nobody@example.com', otp: '000000' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('sign-in with an e-mail code', () => {
  const sendCode = (email: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/send-verification-otp',
      remoteAddress: ip(),
      headers: { origin, ...headers },
      payload: { email, type: 'sign-in' },
    });
  const enter = (email: string, otp: string) =>
    call(null, 'POST', '/api/auth/sign-in/email-otp', { email, otp });
  const newCode = (email: string) =>
    auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
  const wrong = (otp: string) => (otp === '000000' ? '111111' : '000000');

  it('mails a code in the requested language; the first sign-in creates the account', async () => {
    const email = `${randomUUID()}@example.com`;
    expect(
      (await sendCode(email, { 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' })).json(),
    ).toEqual({
      success: true,
    });
    const mail = await mailTo(email, /Код для входа/);
    expect(mail.HTML).toContain('lang="ru"');
    const code = mail.Text.match(/\b\d{6}\b/)?.[0];
    expect(code).toBeDefined();
    const res = await call(null, 'POST', '/api/auth/sign-in/email-otp', {
      email,
      otp: code,
      name: 'Ада',
    });
    expect(res.statusCode, res.body).toBe(200);
    const session = await call(
      { id: '', email, cookie: cookieOf(res) },
      'GET',
      '/api/auth/get-session',
    );
    expect(session.json().user).toMatchObject({ email, name: 'Ада', emailVerified: true });
    // A code works once.
    expect((await enter(email, code!)).statusCode).toBe(400);
    // No name given: the address's local part, so mails never greet an empty name.
    const local = randomUUID();
    const unnamed = await enter(`${local}@example.com`, await newCode(`${local}@example.com`));
    expect(unnamed.json().user.name).toBe(local);
  });

  it('refuses a wrong code, an expired one and a code after 3 wrong tries', async () => {
    const email = (await signUp()).email;
    let otp = await newCode(email);
    expect((await enter(email, wrong(otp))).json()).toMatchObject({ code: 'INVALID_OTP' });
    expect((await enter(email, otp)).statusCode).toBe(200); // a wrong try does not burn the code

    otp = await newCode(email);
    for (let i = 0; i < 3; i++) expect((await enter(email, wrong(otp))).statusCode).toBe(400);
    const locked = await enter(email, otp);
    expect(locked.statusCode).toBe(403);
    expect(locked.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });

    // Expired. Better Auth sweeps expired verification rows on every lookup, from any test file
    // running in parallel, so the answer is OTP_EXPIRED or, once swept, INVALID_OTP: both refuse.
    // (A faked clock here would sweep the other files' fresh codes from the shared database.)
    otp = await newCode(email);
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verification.identifier, `sign-in-otp-${email}`));
    const expired = await enter(email, otp);
    expect(expired.statusCode).toBe(400);
    expect(['OTP_EXPIRED', 'INVALID_OTP']).toContain(expired.json().code);
  });

  it('mails one code per address per 30 s (resend cooldown)', async () => {
    const email = `${randomUUID()}@example.com`;
    expect((await sendCode(email)).statusCode).toBe(200);
    expect((await sendCode(email.toUpperCase())).statusCode).toBe(429); // same address, any IP
    expect((await sendCode(`${randomUUID()}@example.com`)).statusCode).toBe(200);
    // Signing in with a code ends it: sign out and in again right away.
    expect((await enter(email, await newCode(email))).statusCode).toBe(200);
    expect((await sendCode(email)).statusCode).toBe(200);
  });
});

describe('transactional email', () => {
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

describe('sign-up protection (disposable email)', () => {
  // Asking for a code: refused before a code exists or a mail goes out.
  const signUpRes = (email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/send-verification-otp',
      remoteAddress: ip(),
      headers: { origin },
      payload: { email, type: 'sign-in' },
    });
  /** Runs `fn` with extra allow/deny domains, restoring the parsed env afterwards. */
  async function withDomains(allow: string[], deny: string[], fn: () => Promise<void>) {
    const saved = [env.SIGNUP_EMAIL_ALLOW_DOMAINS, env.SIGNUP_EMAIL_DENY_DOMAINS];
    Object.assign(env, { SIGNUP_EMAIL_ALLOW_DOMAINS: allow, SIGNUP_EMAIL_DENY_DOMAINS: deny });
    try {
      await fn();
    } finally {
      [env.SIGNUP_EMAIL_ALLOW_DOMAINS, env.SIGNUP_EMAIL_DENY_DOMAINS] = saved as [
        string[],
        string[],
      ];
    }
  }

  it('refuses a disposable address at sign-up with a neutral 400, accepts a normal one', async () => {
    for (const email of [`${randomUUID()}@mailinator.com`, `${randomUUID()}@Sub.YOPmail.com`]) {
      const res = await signUpRes(email);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_ALLOWED', message: DISPOSABLE_EMAIL });
    }
    expect((await signUpRes(`${randomUUID()}@example.com`)).statusCode).toBe(200);
    // A code obtained anyway (the list grew in between) still creates no account.
    const late = await codeSignIn(app, `${randomUUID()}@mailinator.com`);
    expect(late.json()).toMatchObject({ code: 'EMAIL_NOT_ALLOWED' });
  });

  it('honours the operator allow-list and deny-list', async () => {
    await withDomains(['mailinator.com'], ['example.org'], async () => {
      expect((await signUpRes(`${randomUUID()}@mailinator.com`)).statusCode).toBe(200);
      expect((await signUpRes(`${randomUUID()}@team.example.org`)).statusCode).toBe(400);
    });
  });

  it('refuses users created without the form (SSO, operator) and email changes', async () => {
    // OIDC and admin sign-ups go through the same internal adapter and its database hook.
    const { internalAdapter } = await auth.$context;
    for (const method of ['oauth', 'admin'] as const) {
      await expect(
        internalAdapter.createUser(
          { email: `${randomUUID()}@mailinator.com`, name: 'T' },
          { method },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    const user = await signUp();
    await expect(
      internalAdapter.updateUser(user.id, { email: `${randomUUID()}@mailinator.com` }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(internalAdapter.updateUser(user.id, { name: 'Renamed' })).resolves.toBeTruthy();
  });

  it('refuses an invitation to a disposable address', async () => {
    const owner = await signUp();
    const org = await createOrg(owner);
    const invite = (email: string) =>
      call(owner, 'POST', '/api/auth/organization/invite-member', {
        email,
        role: 'member',
        organizationId: org,
      });
    const refused = await invite(`${randomUUID()}@mailinator.com`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe(DISPOSABLE_EMAIL);
    await withDomains(['mailinator.com'], [], async () => {
      expect((await invite(`${randomUUID()}@mailinator.com`)).statusCode).toBe(200);
    });
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

/** The argument a workflow was started with (first event of its history). */
async function startArg(handle: { fetchHistory: () => Promise<unknown> }): Promise<unknown> {
  const history = (await handle.fetchHistory()) as {
    events?: {
      workflowExecutionStartedEventAttributes?: { input?: { payloads?: { data?: Uint8Array }[] } };
    }[];
  };
  const data =
    history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
  return data ? JSON.parse(Buffer.from(data).toString('utf8')) : undefined;
}

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
      last_checked_at: randomUUID(), // a new text per test run: workflow ids are never reused
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
      release: randomUUID(),
    },
  };

  it('needs the shared secret', async () => {
    expect((await hook(null, alert)).statusCode).toBe(401);
    expect((await hook('wrong', alert)).statusCode).toBe(401);
  });

  /** The item the worker will file: S3 object + TrackerItemWorkflow with only producer and key. */
  const stored = async (res: { key: string }) => {
    const id = `tracker-item-${res.key.slice('tracker-inbox/'.length, -'.json'.length)}`;
    const handle = (await temporal()).workflow.getHandle(id);
    const arg = await startArg(handle);
    const item = (await getJson(env.S3_BUCKET, res.key)) as { title: string; body: string };
    await handle.terminate('test cleanup').catch(() => {}); // the worker may have finished it
    return { item, arg };
  };

  it('hands the redacted item to the worker through S3 and ignores unrelated events', async () => {
    const secret = env.POSTHOG_WEBHOOK_SECRET!;
    const started = (await hook(secret, alert)).json();
    expect(started).toMatchObject({ action: 'started', producer: 'cjm-regression' });
    // A redelivered webhook (same text, same workflow id) files nothing twice.
    expect((await hook(secret, alert)).json()).toMatchObject({ action: 'duplicate' });
    const { item, arg } = await stored(started);
    expect(item.title).toBe('[cjm] activation below 30%');
    expect(item.body).toContain('below the lower threshold');
    expect(arg).toEqual({ producer: 'cjm-regression', s3Key: started.key }); // no text in Temporal

    const feedback = (await hook(secret, survey)).json();
    expect(feedback).toMatchObject({ action: 'started', producer: 'from-users' });
    const filed = await stored(feedback);
    expect(JSON.stringify(filed.item)).not.toContain('a@example.com');
    expect(filed.item.title).toBe('[feedback] Upload fails, mail me at [email]');
    expect((await hook(secret, { event: '$pageview', properties: {} })).json()).toEqual({
      action: 'ignored',
    });
    // Thumbs on AI answers stay in PostHog AI observability.
    const thumbs = { ...survey, properties: { ...survey.properties, $ai_trace_id: 't' } };
    expect((await hook(secret, thumbs)).json()).toEqual({ action: 'ignored' });
  });

  it('redacts answers with the PII sidecar and fails closed when it is down', async () => {
    Object.assign(env, { PII_REDACT_URL: 'http://pii.test:8000' });
    const sidecar: string[][] = [];
    let up = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('http://pii.test:8000/redact'); // the only HTTP call it makes
      if (!up) throw new TypeError('fetch failed');
      const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
      sidecar.push(texts);
      return Response.json({ texts: texts.map(() => 'Upload fails, call [name] at [phone]') });
    });
    try {
      const secret = env.POSTHOG_WEBHOOK_SECRET!;
      const res = (await hook(secret, survey)).json();
      expect(res).toMatchObject({ action: 'started', producer: 'from-users' });
      const { item } = await stored(res);
      expect(item.title).toBe('[feedback] Upload fails, call [name] at [phone]');
      expect(item.body).toContain('call [name] at [phone]');
      expect(sidecar).toEqual([['Upload fails, mail me at a@example.com']]);
      up = false;
      const down = await hook(secret, survey);
      expect(down.statusCode).toBe(503);
      expect(down.body).not.toContain('example.com');
      // Alerts carry no user text and do not need the sidecar.
      const again = { ...alert, properties: { ...alert.properties, state: 'Firing again' } };
      const filed = await hook(secret, again);
      expect(filed.statusCode).toBe(200);
      await stored(filed.json());
    } finally {
      fetchMock.mockRestore();
      Object.assign(env, { PII_REDACT_URL: undefined });
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
    const history = await historyText(handle);
    expect(history).toContain(String(c.conversationId)); // decoded: the check can fail
    expect(history).not.toContain('customer text');
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
    expect(await startArg(rel)).toMatchObject({ release: 'v1.2.0' });
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

    // The release comment (worker/released.py) on a Plane item: live in that version.
    const comment = (text: string) => ({
      event: 'workitem.comment.created',
      event_id: randomUUID(),
      entity_type: 'issue',
      data: {
        id: event.data.id,
        name: 'x',
        comment: { comment_stripped: text, actor_id: 'u-bot' },
      },
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
    // The author goes along: the worker acts only on its own integration user's comments.
    expect(await startArg(rel)).toMatchObject({ release: 'v1.2.0', author: 'u-bot' });
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
      activity: { field: null, actor: { id: 'u-bot-v1', display_name: 'Release bot' } },
    };
    expect((await v1(v1Comment)).json()).toEqual({ action: 'started' });
    const v1Rel = (await temporal()).workflow.getHandle(
      supportClosedWorkflowId({ tracker: 'plane', issueId: v1Id }, 'release-v2.0.0'),
    );
    expect(await startArg(v1Rel)).toMatchObject({ release: 'v2.0.0', author: 'u-bot-v1' });
    await v1Rel.terminate('test cleanup');
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
