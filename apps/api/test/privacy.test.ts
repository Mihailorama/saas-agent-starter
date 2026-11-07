// Data-subject rights API (docs/privacy.md): requests, rate limit, re-auth, owner rules, cancel,
// download and audit rows. The workflows themselves run in services/worker-py/tests/test_privacy.py.
import { randomUUID } from 'node:crypto';
import { auditLog, privacyRequests, session, user as users, withOrg } from '@app/db';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { db, pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { gaClientId, NOT_FRESH } from '../src/routes/privacy.ts';
import { ensureBucket } from '../src/s3.ts';
import { closeTemporal, privacyWorkflowId, temporal } from '../src/temporal.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const password = 'correct-horse-battery';
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
type User = { id: string; cookie: string };
const started: string[] = [];

beforeAll(() => ensureBucket());
afterAll(async () => {
  // Nothing may keep running against the shared Temporal (grace-period timers, exports).
  const client = await temporal();
  await Promise.all(
    started.map((id) =>
      client.workflow
        .getHandle(id)
        .terminate('test cleanup')
        .catch(() => undefined),
    ),
  );
  await app.close();
  await closeTemporal();
  await pool.end();
});

const req = (u: User | null, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, ...(u && { cookie: u.cookie }) },
    ...(payload && { payload }),
  });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function signUp(): Promise<User> {
  const email = `${randomUUID()}@example.com`;
  const res = await req(null, 'POST', '/api/auth/sign-up/email', { email, password, name: 'T' });
  expect(res.statusCode).toBe(200);
  const id: string = res.json().user.id;
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, id));
  const signedIn = await req(null, 'POST', '/api/auth/sign-in/email', { email, password });
  expect(signedIn.statusCode).toBe(200);
  return { id, cookie: cookieOf(signedIn) };
}

async function createOrg(u: User): Promise<string> {
  const res = await req(u, 'POST', '/api/auth/organization/create', {
    name: 'Org',
    slug: randomUUID(),
  });
  expect(res.statusCode).toBe(200);
  return res.json().id;
}

/** Starts a request and remembers its workflow for cleanup. */
async function request(u: User, path: string) {
  const res = await req(u, 'POST', `/api/privacy/${path}`);
  if (res.statusCode === 202) {
    const r = res.json();
    started.push(privacyWorkflowId({ kind: r.kind, requestId: r.id }));
  }
  return res;
}

const audits = (orgId: string, target: string) =>
  withOrg(db, orgId, (tx) =>
    tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.target, target)),
  );

describe('privacy: user', () => {
  it('starts an export once per interval, audited, with the "ready" mail in the workflow', async () => {
    const u = await signUp();
    const orgId = await createOrg(u);
    const res = await request(u, 'user/export');
    expect(res.statusCode).toBe(202);
    const r = res.json();
    expect(r).toMatchObject({ kind: 'export', status: 'running', downloadable: false });

    const handle = (await temporal()).workflow.getHandle(
      privacyWorkflowId({ kind: 'export', requestId: r.id }),
    );
    const run = await handle.describe();
    expect(run.type).toBe('DataExportWorkflow');
    const [arg] =
      (await handle.fetchHistory()).events?.[0]?.workflowExecutionStartedEventAttributes?.input
        ?.payloads ?? [];
    const input = JSON.parse(Buffer.from(arg!.data!).toString());
    expect(input).toMatchObject({ subjectType: 'user', subjectId: u.id, kind: 'export' });
    expect(input.email.kind).toBe('data-export-ready');
    expect(input.email.text).toContain('/settings/privacy');

    expect((await request(u, 'user/export')).statusCode).toBe(429);
    expect(await audits(orgId, r.id)).toEqual([{ action: 'privacy.export_requested' }]);

    const list = await req(u, 'GET', '/api/privacy/user/requests');
    expect(list.json().map((x: { id: string }) => x.id)).toEqual([r.id]);
    // Not ready yet, and never someone else's.
    expect((await req(u, 'GET', `/api/privacy/user/requests/${r.id}/download`)).statusCode).toBe(
      404,
    );
  });

  it('downloads a finished export through a fresh presigned link, only for its subject', async () => {
    const u = await signUp();
    const other = await signUp();
    const key = `privacy-exports/${randomUUID()}.zip`;
    const s3 = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
    await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: 'zip' }));
    const [row] = await db
      .insert(privacyRequests)
      .values({
        kind: 'export',
        subjectType: 'user',
        subjectId: u.id,
        requestedBy: u.id,
        status: 'completed',
        resultKey: key,
      })
      .returning();
    const res = await req(u, 'GET', `/api/privacy/user/requests/${row!.id}/download`);
    expect(res.statusCode).toBe(200);
    const file = await fetch(res.json().url);
    expect(await file.text()).toBe('zip');
    expect(
      (await req(other, 'GET', `/api/privacy/user/requests/${row!.id}/download`)).statusCode,
    ).toBe(404);
  });

  it('schedules a deletion after the grace period, needs a fresh sign-in, can be cancelled', async () => {
    const u = await signUp();
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(session.userId, u.id));
    const stale = await request(u, 'user/deletion');
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error).toBe(NOT_FRESH);
    await db.update(session).set({ createdAt: new Date() }).where(eq(session.userId, u.id));

    const res = await request(
      { ...u, cookie: `${u.cookie}; _ga=GA1.1.1234567890.1700000000` },
      'user/deletion',
    );
    expect(res.statusCode).toBe(202);
    const r = res.json();
    expect(r.status).toBe('scheduled');
    const graceMs = new Date(r.executeAfter).getTime() - Date.now();
    expect(Math.abs(graceMs - env.PRIVACY_DELETION_GRACE_DAYS * 86_400_000)).toBeLessThan(60_000);
    expect((await request(u, 'user/deletion')).statusCode).toBe(409);

    const handle = (await temporal()).workflow.getHandle(
      privacyWorkflowId({ kind: 'deletion', requestId: r.id }),
    );
    const input = JSON.parse(
      Buffer.from(
        (await handle.fetchHistory()).events![0]!.workflowExecutionStartedEventAttributes!.input!
          .payloads![0]!.data!,
      ).toString(),
    );
    expect(input).toMatchObject({ kind: 'deletion', gaClientId: '1234567890.1700000000' });

    const cancelled = await req(u, 'POST', `/api/privacy/user/requests/${r.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect((await req(u, 'POST', `/api/privacy/user/requests/${r.id}/cancel`)).statusCode).toBe(
      409,
    );
    // A new request is possible again after cancelling.
    // The web sends gtag's client id in the body; it wins over the cookie.
    const again = await req(u, 'POST', '/api/privacy/user/deletion', { gaClientId: '42.43' });
    expect(again.statusCode).toBe(202);
    const id = privacyWorkflowId({ kind: 'deletion', requestId: again.json().id });
    started.push(id);
    const history = await (await temporal()).workflow.getHandle(id).fetchHistory();
    const arg = history.events![0]!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!;
    expect(JSON.parse(Buffer.from(arg.data!).toString()).gaClientId).toBe('42.43');
  });

  it('refuses to delete the only owner of an organization', async () => {
    const u = await signUp();
    await createOrg(u);
    const res = await request(u, 'user/deletion');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/only owner/);
  });

  it('needs a session', async () => {
    expect((await req(null, 'POST', '/api/privacy/user/export')).statusCode).toBe(401);
    const key = await req(null, 'GET', '/api/privacy/user/requests');
    expect(key.statusCode).toBe(401);
  });
});

describe('privacy: organization', () => {
  it('is for owners only; requests are audited in the organization', async () => {
    const owner = await signUp();
    const orgId = await createOrg(owner);
    const member = await signUp();
    await pool.query(
      `insert into member (id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, 'member', now())`,
      [randomUUID(), orgId, member.id],
    );
    await req(member, 'POST', '/api/auth/organization/set-active', { organizationId: orgId });
    expect((await request(member, 'org/export')).statusCode).toBe(403);
    expect((await request(member, 'org/deletion')).statusCode).toBe(403);

    const exp = await request(owner, 'org/export');
    expect(exp.statusCode).toBe(202);
    expect(await audits(orgId, exp.json().id)).toEqual([
      { action: 'POST /api/privacy/org/export' },
    ]);

    const del = await request(owner, 'org/deletion');
    expect(del.statusCode).toBe(202);
    const [row] = await db
      .select()
      .from(privacyRequests)
      .where(and(eq(privacyRequests.id, del.json().id), eq(privacyRequests.subjectId, orgId)));
    expect(row).toMatchObject({ subjectType: 'org', requestedBy: owner.id, status: 'scheduled' });
    // The member cannot see or cancel it.
    expect((await req(member, 'GET', '/api/privacy/org/requests')).statusCode).toBe(403);
    const cancel = await req(owner, 'POST', `/api/privacy/org/requests/${row!.id}/cancel`);
    expect(cancel.json().status).toBe('cancelled');
    expect(await audits(orgId, row!.id)).toHaveLength(2);
  });
});

describe('gaClientId', () => {
  it('reads the client id from the _ga cookie only', () => {
    expect(gaClientId('a=1; _ga=GA1.1.123.456; b=2')).toBe('123.456');
    expect(gaClientId('_ga_XYZ=GS1.1.1; x=1')).toBeUndefined();
    expect(gaClientId(undefined)).toBeUndefined();
  });
});
