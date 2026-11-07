#!/usr/bin/env node
// `pnpm seo:report [--days 28] [--json]`: Google Search Console summary for the site: clicks,
// impressions, CTR, average position, top queries and top pages (docs/marketing.md).
// Env: GSC_SITE_URL (the property: `sc-domain:example.com` or `https://example.com/`) and
// GSC_CREDENTIALS (path to a service-account JSON key, or the JSON itself). The service account
// must be added as a user of the property. Without them it prints the planned requests (dry run).
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://www.googleapis.com/webmasters/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const b64url = (s) => Buffer.from(s).toString('base64url');

/** Signed JWT for Google's service-account OAuth flow (RFC 7523 bearer grant). */
export function jwt(sa, now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const body = `${head}.${b64url(JSON.stringify(claims))}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(sa.private_key, 'base64url')}`;
}

/** Search Console data lags ~2-3 days: the window ends 3 days ago. */
export function range(days, today = new Date()) {
  const day = (offset) =>
    new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
  return { startDate: day(days + 2), endDate: day(3) };
}

/** The three queries: totals, top queries, top pages. */
export function requests(days, today) {
  const r = range(days, today);
  return {
    totals: { ...r },
    queries: { ...r, dimensions: ['query'], rowLimit: 10 },
    pages: { ...r, dimensions: ['page'], rowLimit: 10 },
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pos = (x) => x.toFixed(1);

export function summarize(site, req, res) {
  const t = res.totals.rows?.[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const table = (rows = []) =>
    rows.length
      ? rows.map(
          (r, i) =>
            `  ${String(i + 1).padStart(2)}. ${r.keys[0]}  clicks ${r.clicks}, impr ${r.impressions}, ctr ${pct(r.ctr)}, pos ${pos(r.position)}`,
        )
      : ['  (no data)'];
  return [
    `Search Console: ${site}, ${req.totals.startDate} .. ${req.totals.endDate}`,
    `Clicks ${t.clicks}, impressions ${t.impressions}, CTR ${pct(t.ctr)}, avg position ${pos(t.position)}`,
    'Top queries:',
    ...table(res.queries.rows),
    'Top pages:',
    ...table(res.pages.rows),
  ].join('\n');
}

async function token(sa) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt(sa),
    }),
  });
  if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function main(argv) {
  const days = Number(argv[argv.indexOf('--days') + 1]) || 28;
  const site = process.env.GSC_SITE_URL;
  const creds = process.env.GSC_CREDENTIALS;
  const req = requests(days);
  const url = `${API}/sites/${encodeURIComponent(site ?? '<GSC_SITE_URL>')}/searchAnalytics/query`;
  if (!site || !creds || argv.includes('--dry-run')) {
    console.log('dry run (set GSC_SITE_URL and GSC_CREDENTIALS to query):');
    for (const body of Object.values(req)) console.log(`POST ${url} ${JSON.stringify(body)}`);
    return;
  }
  const sa = JSON.parse(creds.trim().startsWith('{') ? creds : readFileSync(creds, 'utf8'));
  const auth = { authorization: `Bearer ${await token(sa)}`, 'content-type': 'application/json' };
  const res = {};
  for (const [name, body] of Object.entries(req)) {
    const r = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    res[name] = await r.json();
  }
  console.log(argv.includes('--json') ? JSON.stringify(res, null, 2) : summarize(site, req, res));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`seo:report: ${e.message}`);
    process.exit(1);
  });
}
