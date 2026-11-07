import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { auth } from '../src/auth.ts';
import { pool } from '../src/db.ts';
import { allowedOrigins, env } from '../src/env.ts';
import { closeTemporal, crmWorkflowId, temporal } from '../src/temporal.ts';

// CRM sync starts (docs/crm.md): the API verifies the webhook and starts CrmSyncWorkflow with ids
// (plus the attendee for bookings); the worker's side is services/worker-py/tests/test_crm.py.
const app = await buildApp();
const secrets = {
  CALCOM_WEBHOOK_SECRET: 'test-calcom-secret',
  POSTHOG_WEBHOOK_SECRET: 'test-posthog-secret',
  CHATWOOT_WEBHOOK_SECRET: 'test-chatwoot-secret',
};
beforeAll(() => Object.assign(env, secrets));
afterAll(async () => {
  Object.assign(env, Object.fromEntries(Object.keys(secrets).map((k) => [k, undefined])));
  await app.close();
  await closeTemporal();
  await pool.end();
});

const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
const hex = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');
const post = (url: string, body: string, headers: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
/** Type and decoded input of the workflow, then terminates it (no work left for a worker). */
async function started(eventId: string) {
  const handle = (await temporal()).workflow.getHandle(crmWorkflowId(eventId));
  const run = await handle.describe();
  const first = (await handle.fetchHistory()).events?.[0];
  const data = first?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
  await handle.terminate('test cleanup');
  return { type: run.type, input: Buffer.from(data ?? []).toString('utf8') };
}

describe('Cal.com webhook -> CRM', () => {
  const booking = (trigger: string, uid = randomUUID()) => ({
    triggerEvent: trigger,
    createdAt: '2026-11-07T10:00:00Z',
    payload: {
      uid,
      title: 'Demo between Acme and Grace',
      startTime: '2026-11-10T10:00:00Z',
      endTime: '2026-11-10T10:30:00Z',
      attendees: [{ email: 'grace@example.com', name: 'Grace Hopper', timeZone: 'UTC' }],
      organizer: { email: 'sales@example.com', name: 'Sales' },
      responses: { notes: 'free text the CRM does not need' },
    },
  });
  const calcom = (event: object, secret = secrets.CALCOM_WEBHOOK_SECRET) => {
    const body = JSON.stringify(event);
    return post('/api/hooks/calcom', body, { 'x-cal-signature-256': hex(secret, body) });
  };

  it('checks the signature over the raw body and needs the secret set', async () => {
    expect((await calcom(booking('BOOKING_CREATED'), 'wrong')).statusCode).toBe(401);
    const body = JSON.stringify(booking('BOOKING_CREATED'));
    const forged = await post('/api/hooks/calcom', body.replace('Grace', 'Mallory'), {
      'x-cal-signature-256': hex(secrets.CALCOM_WEBHOOK_SECRET, body),
    });
    expect(forged.statusCode).toBe(401);
    const unsigned = await post('/api/hooks/calcom', body, {
      'x-cal-signature-256': 'no-secret-provided', // what Cal.com sends without a secret
    });
    expect(unsigned.statusCode).toBe(401);
    env.CALCOM_WEBHOOK_SECRET = undefined;
    try {
      expect((await calcom(booking('BOOKING_CREATED'))).statusCode).toBe(401);
    } finally {
      env.CALCOM_WEBHOOK_SECRET = secrets.CALCOM_WEBHOOK_SECRET;
    }
  });

  it('starts one workflow per booking change; other triggers are ignored', async () => {
    expect((await calcom({ triggerEvent: 'PING', payload: {} })).json()).toEqual({
      action: 'ignored',
    });
    expect((await calcom(booking('MEETING_ENDED'))).json()).toEqual({ action: 'ignored' });
    for (const trigger of ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED']) {
      const event = booking(trigger);
      expect((await calcom(event)).json()).toEqual({ action: 'started' });
      expect((await calcom(event)).json()).toEqual({ action: 'duplicate' }); // redelivery
      const run = await started(`cal:${trigger}:${event.payload.uid}:2026-11-10T10:00:00Z`);
      expect(run.type).toBe('CrmSyncWorkflow');
      expect(JSON.parse(run.input).booking.attendeeEmail).toBe('grace@example.com');
      expect(run.input).not.toContain('free text'); // only what the note needs
    }
  });
});

describe('PostHog signal -> CRM', () => {
  const hook = (body: object, secret = secrets.POSTHOG_WEBHOOK_SECRET) =>
    post('/api/hooks/posthog', JSON.stringify(body), { 'x-webhook-secret': secret });

  it('starts one workflow per PostHog event and needs the shared secret', async () => {
    const event = { uuid: randomUUID(), event: 'project_created', distinct_id: 'user-1' };
    const body = { event, signal: 'ACTIVE_TEAM_FREE' };
    expect((await hook(body, 'wrong')).statusCode).toBe(401);
    expect((await hook({ event: { event: 'x' }, signal: 'ACTIVE_TEAM_FREE' })).json()).toEqual({
      action: 'ignored',
    });
    expect((await hook(body)).json()).toEqual({ action: 'started' });
    expect((await hook(body)).json()).toEqual({ action: 'duplicate' });
    expect((await started(`posthog:${event.uuid}`)).type).toBe('CrmSyncWorkflow');
  });
});

describe('Chatwoot conversation -> CRM', () => {
  it('starts one workflow per new conversation', async () => {
    const id = Math.floor(Math.random() * 1e9);
    const body = JSON.stringify({ event: 'conversation_created', id, account: { id: 1 } });
    const ts = String(Math.floor(Date.now() / 1000));
    const send = () =>
      post('/api/hooks/chatwoot', body, {
        'x-chatwoot-signature': `sha256=${hex(secrets.CHATWOOT_WEBHOOK_SECRET, `${ts}.${body}`)}`,
        'x-chatwoot-timestamp': ts,
      });
    expect((await send()).json()).toEqual({ action: 'started' });
    expect((await send()).json()).toEqual({ action: 'duplicate' });
    expect((await started(`chatwoot:1:${id}`)).type).toBe('CrmSyncWorkflow');
  });
});

describe('sign-up and new organization -> CRM', () => {
  it('starts a person sync on sign-up and a company sync on organization create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      remoteAddress: ip(),
      headers: { origin: allowedOrigins[0]! },
      payload: {
        email: `${randomUUID()}@example.com`,
        password: 'correct-horse-battery',
        name: 'T',
      },
    });
    expect(res.statusCode).toBe(200);
    const userId: string = res.json().user.id;
    const run = await started(`user:${userId}`);
    expect(run.type).toBe('CrmSyncWorkflow');
    expect(JSON.parse(run.input)).toEqual({
      kind: 'user.created',
      eventId: `user:${userId}`,
      userId,
    }); // ids only

    const org = await auth.api.createOrganization({
      body: { name: 'Acme', slug: randomUUID(), userId },
    });
    expect((await started(`org:${org!.id}`)).type).toBe('CrmSyncWorkflow');
  });
});
