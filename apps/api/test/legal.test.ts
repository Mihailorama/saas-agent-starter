// Legal baseline (docs/legal.md): terms/privacy acceptance at sign-up and on a new version, the
// age self-attestation, marketing consent and one-click unsubscribe (RFC 8058).
import { randomUUID } from 'node:crypto';
import { user } from '@app/db';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { db, pool } from '../src/db.ts';
import { MARKETING_KINDS, renderEmail, TRANSACTIONAL_KINDS } from '../src/email.ts';
import { allowedOrigins, env } from '../src/env.ts';
import {
  LEGAL,
  sendMarketingEmail,
  unsubscribeLinks,
  unsubscribeToken,
  verifyUnsubscribe,
} from '../src/legal.ts';
import { closeTemporal } from '../src/temporal.ts';
import { acceptLegal, signUp } from './sign-in.ts';

const app = await buildApp();
const origin = allowedOrigins[0]!;
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const ip = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;

afterAll(async () => {
  await app.close();
  await closeTemporal();
  await pool.end();
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, cookie?: string, payload?: object) =>
  app.inject({
    method,
    url,
    remoteAddress: ip(),
    headers: { origin, ...(cookie && { cookie }) },
    ...(payload && { payload }),
  });
const row = async (id: string) => (await db.select().from(user).where(eq(user.id, id)))[0]!;
const accept = (cookie: string, body: object) =>
  call('POST', '/api/legal/accept', cookie, {
    terms: LEGAL.terms,
    privacy: LEGAL.privacy,
    ...body,
  });

describe('acceptance at sign-up', () => {
  it('a new account must accept before it can use the product', async () => {
    const { cookie, id } = await signUp(app, undefined, {}, { accept: false });
    const status = (await call('GET', '/api/legal/', cookie)).json();
    expect(status).toMatchObject({
      required: true,
      firstTime: true,
      minAge: 16,
      marketingOptIn: false,
      terms: LEGAL.terms,
      privacy: LEGAL.privacy,
    });

    // Refused both on Better Auth's organization endpoints and on tenant routes.
    const org = await call('POST', '/api/auth/organization/create', cookie, {
      name: 'Org',
      slug: randomUUID(),
    });
    expect(org.statusCode).toBe(403);
    expect(org.json().code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    // Data-subject rights stay available.
    expect((await call('GET', '/api/privacy/user/requests', cookie)).statusCode).toBe(200);

    // Stale versions, then a missing age confirmation, are refused.
    expect((await accept(cookie, { terms: 'old', ageConfirmed: true })).statusCode).toBe(409);
    expect((await accept(cookie, {})).statusCode).toBe(400);
    expect((await row(id)).termsVersion).toBeNull();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/legal/accept',
      remoteAddress: ip(),
      headers: { origin, cookie, 'accept-language': 'ru-RU,ru;q=0.9' },
      payload: {
        terms: LEGAL.terms,
        privacy: LEGAL.privacy,
        ageConfirmed: true,
        marketingOptIn: true,
      },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ required: false, firstTime: false, marketingOptIn: true });
    const r = await row(id);
    expect(r).toMatchObject({
      termsVersion: LEGAL.terms,
      privacyVersion: LEGAL.privacy,
      locale: 'ru',
    });
    expect(r.legalAcceptedAt).toBeInstanceOf(Date);
    expect(r.ageConfirmedAt).toBeInstanceOf(Date);
    expect(r.marketingOptInAt).toBeInstanceOf(Date);

    const created = await call('POST', '/api/auth/organization/create', cookie, {
      name: 'Org',
      slug: randomUUID(),
    });
    expect(created.statusCode, created.body).toBe(200);
    expect((await call('GET', '/api/projects', cookie)).statusCode).toBe(200);
  });

  it('asks again when a document version changes, keeping the marketing choice', async () => {
    const { cookie, id } = await signUp(app);
    await call('POST', '/api/auth/organization/create', cookie, {
      name: 'Org',
      slug: randomUUID(),
    });
    expect((await call('GET', '/api/projects', cookie)).statusCode).toBe(200);

    // A new terms version in config/legal.json looks like this to an existing user.
    await db.update(user).set({ termsVersion: '2000-01-01' }).where(eq(user.id, id));
    expect((await call('GET', '/api/legal/', cookie)).json()).toMatchObject({
      required: true,
      firstTime: false,
    });
    const refused = await call('GET', '/api/projects', cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('legal acceptance required');

    expect((await accept(cookie, { ageConfirmed: true })).statusCode).toBe(200);
    expect((await call('GET', '/api/projects', cookie)).statusCode).toBe(200);
    expect((await row(id)).marketingOptIn).toBe(false);
  });

  it('needs a session', async () => {
    expect((await call('GET', '/api/legal/')).statusCode).toBe(401);
    expect((await accept('', { ageConfirmed: true })).statusCode).toBe(401);
  });
});

describe('marketing consent', () => {
  it('is opt-in and can be switched in settings', async () => {
    const { cookie, id } = await signUp(app);
    expect((await row(id)).marketingOptIn).toBe(false);
    const on = await call('PUT', '/api/legal/marketing', cookie, { optIn: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().marketingOptIn).toBe(true);
    const off = await call('PUT', '/api/legal/marketing', cookie, { optIn: false });
    expect(off.json().marketingOptIn).toBe(false);
  });

  it('one-click unsubscribe (RFC 8058 POST) and the page token both opt out', async () => {
    const { cookie, id } = await signUp(app);
    await call('PUT', '/api/legal/marketing', cookie, { optIn: true });
    const res = await app.inject({
      method: 'POST',
      url: `/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken(id))}`,
      remoteAddress: ip(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await row(id)).marketingOptIn).toBe(false);

    await call('PUT', '/api/legal/marketing', cookie, { optIn: true });
    const page = await call('POST', '/api/unsubscribe', undefined, { token: unsubscribeToken(id) });
    expect(page.statusCode, page.body).toBe(200);
    expect((await row(id)).marketingOptIn).toBe(false);

    const forged = `${id}.${'A'.repeat(43)}`;
    expect((await call('POST', '/api/unsubscribe', undefined, { token: forged })).statusCode).toBe(
      400,
    );
    expect((await call('POST', '/api/unsubscribe', undefined, {})).statusCode).toBe(400);
  });

  it('limits unsubscribe per token, not per IP; a rotated secret still verifies', async () => {
    const one = unsubscribeToken((await signUp(app)).id);
    const two = unsubscribeToken((await signUp(app)).id);
    const post = (token: string) =>
      app.inject({
        method: 'POST',
        url: `/api/unsubscribe?token=${encodeURIComponent(token)}`,
        remoteAddress: '10.9.9.9', // one shared mail-provider address
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await post(one)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await post(two)).statusCode).toBe(200);

    // Rotation: links signed before BETTER_AUTH_SECRET changed still work with the previous one.
    const before = env.BETTER_AUTH_SECRET;
    const old = unsubscribeToken((await signUp(app)).id);
    try {
      env.BETTER_AUTH_SECRET = 'x'.repeat(40);
      expect(verifyUnsubscribe(old)).toBeUndefined();
      env.BETTER_AUTH_PREVIOUS_SECRET = before;
      expect(verifyUnsubscribe(old)).toBe(old.split('.')[0]);
    } finally {
      env.BETTER_AUTH_SECRET = before;
      env.BETTER_AUTH_PREVIOUS_SECRET = undefined;
    }
  });

  it('marketing mail goes only to opted-in users, with the unsubscribe link and headers', async () => {
    const out = await signUp(app);
    expect(await sendMarketingEmail(out.id, 'product-update', 'https://example.com', 'c1')).toBe(
      false,
    );
    const unverified = await signUp(app);
    await acceptLegal(app, unverified.cookie, true);
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, unverified.id));
    expect(
      await sendMarketingEmail(unverified.id, 'product-update', 'https://example.com', 'c1'),
    ).toBe(false);
    const inn = await signUp(app);
    await acceptLegal(app, inn.cookie, true);
    expect(await sendMarketingEmail(inn.id, 'product-update', 'https://example.com', 'c1')).toBe(
      true,
    );
    await expect(
      sendMarketingEmail(inn.id, 'invitation', 'https://example.com', 'c1'),
    ).rejects.toThrow();

    // Delivered by the worker (pnpm worker) into Mailpit with the RFC 8058 headers.
    const links = unsubscribeLinks(inn.id);
    let headers: Record<string, string[]> | undefined;
    for (let i = 0; i < 100 && !headers; i++) {
      const q = new URLSearchParams({ query: `to:${inn.email}` });
      const { messages } = await (await fetch(`${mailpit}/api/v1/search?${q}`)).json();
      if (messages[0]) {
        headers = await (await fetch(`${mailpit}/api/v1/message/${messages[0].ID}/headers`)).json();
      } else await new Promise((r) => setTimeout(r, 100));
    }
    expect(headers?.['List-Unsubscribe']).toEqual([`<${links.oneClick}>`]);
    expect(headers?.['List-Unsubscribe-Post']).toEqual(['List-Unsubscribe=One-Click']);
  });
});

describe('email templates', () => {
  it('every kind is either transactional or marketing; marketing ones carry unsubscribe', async () => {
    expect(new Set([...TRANSACTIONAL_KINDS, ...MARKETING_KINDS]).size).toBe(
      TRANSACTIONAL_KINDS.length + MARKETING_KINDS.length,
    );
    const links = {
      page: 'https://app.example.com/unsubscribe?token=t',
      oneClick: 'https://app.example.com/api/unsubscribe?token=t',
    };
    for (const kind of MARKETING_KINDS) {
      await expect(renderEmail(kind, 'en', 'https://example.com')).rejects.toThrow();
      for (const locale of ['en', 'ru'] as const) {
        const mail = await renderEmail(kind, locale, 'https://example.com', {}, links);
        expect(mail.html).toContain(links.page.replaceAll('&', '&amp;'));
        expect(mail.text).toContain(links.page);
        expect(mail.headers).toEqual({
          'List-Unsubscribe': `<${links.oneClick}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        });
      }
    }
    for (const kind of TRANSACTIONAL_KINDS) {
      expect((await renderEmail(kind, 'en', 'https://example.com')).headers).toBeUndefined();
    }
  });
});
