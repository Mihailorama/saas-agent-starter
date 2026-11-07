// node --test 'scripts/*.test.mjs' (part of pnpm check:ts). Pure parts of the marketing scripts.
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { analyze, claudeArgs, report } from './geo-check.mjs';
import { body, changedUrls } from './indexnow.mjs';
import { jwt, range, requests, summarize } from './seo-report.mjs';

test('seo:report signs a service-account JWT for the read-only Search Console scope', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'seo@example.iam.gserviceaccount.com', private_key: privateKey };
  const token = jwt(sa, 1_000);
  const [head, claims, sig] = token.split('.');
  assert.ok(
    createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, sig, 'base64url'),
  );
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_000,
    exp: 4_600,
  });
});

test('seo:report window ends 3 days ago and spans the requested days', () => {
  assert.deepEqual(range(28, new Date('2026-11-07T12:00:00Z')), {
    startDate: '2026-10-08',
    endDate: '2026-11-04',
  });
  const req = requests(7, new Date('2026-11-07T12:00:00Z'));
  assert.deepEqual(req.queries.dimensions, ['query']);
  assert.equal(req.totals.dimensions, undefined);
  const text = summarize('sc-domain:example.com', req, {
    totals: { rows: [{ clicks: 3, impressions: 100, ctr: 0.03, position: 7.25 }] },
    queries: {
      rows: [{ keys: ['team tool'], clicks: 3, impressions: 50, ctr: 0.06, position: 4 }],
    },
    pages: {},
  });
  assert.match(text, /Clicks 3, impressions 100, CTR 3\.0%, avg position 7\.3/);
  assert.match(text, / 1\. team tool {2}clicks 3/);
  assert.match(text, /Top pages:\n {2}\(no data\)/);
});

test('seo:indexnow maps changed files to site URLs', () => {
  const site = 'https://example.com';
  const all = ['https://example.com/', 'https://example.com/blog/', 'https://example.com/blog/a/'];
  assert.deepEqual(changedUrls([['M', 'apps/site/src/content/blog/a.md']], site, all), all);
  // drafts are not built: not submitted; deleted posts are
  assert.deepEqual(changedUrls([['A', 'apps/site/src/content/blog/draft.mdx']], site, all), [
    'https://example.com/',
    'https://example.com/blog/',
  ]);
  assert.deepEqual(changedUrls([['D', 'apps/site/src/content/blog/old.md']], site, all), [
    'https://example.com/',
    'https://example.com/blog/',
    'https://example.com/blog/old/',
  ]);
  assert.deepEqual(changedUrls([['M', 'apps/site/src/pages/blog/index.astro']], site, all), [
    'https://example.com/blog/',
  ]);
  assert.deepEqual(changedUrls([['M', 'apps/site/src/layouts/Base.astro']], site, all), all);
  assert.deepEqual(changedUrls([['M', 'apps/site/src/pages/rss.xml.ts']], site, all), []);
  assert.deepEqual(changedUrls([['M', 'apps/api/src/app.ts']], site, all), []);
  assert.deepEqual(body(site, 'k123', ['https://example.com/']), {
    host: 'example.com',
    key: 'k123',
    keyLocation: 'https://example.com/k123.txt',
    urlList: ['https://example.com/'],
  });
});

test('geo:check finds mentions, rank, citations and always passes the model', () => {
  const cfg = {
    model: 'claude-opus-5-5',
    product: 'Workspace',
    aliases: ['Workspace.app'],
    domains: ['example.com'],
    competitors: ['Asana', 'Notion'],
  };
  const r = analyze(
    'Try Asana or Workspace (https://docs.example.com/start). Notion is fine. A workspace is a place.',
    cfg,
  );
  assert.equal(r.mentioned, true);
  assert.equal(r.rank, 2);
  assert.deepEqual(r.brands, ['Asana', 'Workspace', 'Notion']);
  assert.deepEqual(r.cited, ['https://docs.example.com/start']);
  const none = analyze('Use Asana. Every team needs a workspace.', cfg);
  assert.equal(none.mentioned, false);
  assert.equal(none.rank, null);
  const args = claudeArgs(cfg, 'q?');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.throws(() => claudeArgs({ ...cfg, model: '' }, 'q?'), /model.*required/);
  const md = report('2026-11-07', cfg, 'claude 2.x', [{ question: 'q?', answer: 'A', ...r }]);
  assert.match(md, /Mentioned in 1\/1 answers; average rank among brands named: 2\.0/);
});
