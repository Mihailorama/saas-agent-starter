#!/usr/bin/env node
// Legal gate (docs/legal.md), part of `pnpm check`:
//   1. config/legal.json is complete, and free of example values unless it says `template: true`;
//   2. the processor catalog covers every browser tool the web reads from env, every cookie the
//      consent banner clears and every tool of the docs/privacy.md data map;
//   3. the stored versions match the texts: config/legal.lock.json pins a hash per document
//      version, so a text never changes under a version users already accepted;
//   4. every legal page builds (with every browser tool on), is linked from the site's footer on
//      every page, from the web app's footers and from sign-up, and the cookie policy lists every
//      enabled analytics/marketing tool;
//   5. every email kind is transactional or marketing, and marketing ones carry the unsubscribe
//      link and the List-Unsubscribe / List-Unsubscribe-Post headers.
// `--no-build` skips 4's site build (unit tests); the rest always runs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOC_IDS, inUse, legalDocs, legalPath } from '../apps/site/src/legal.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const CATEGORIES = new Set(['necessary', 'service', 'functional', 'analytics', 'marketing']);
/** VITE_* keys that configure a tool but do not turn one on (release, flags, options). */
const SETTINGS = new Set([
  'VITE_RELEASE',
  'VITE_FLAGS_ON',
  'VITE_FLAGS_OFF',
  'VITE_SITE_URL',
  'VITE_SENTRY_ENVIRONMENT',
  'VITE_SENTRY_RELEASE',
  'VITE_POSTHOG_HOST',
  'VITE_POSTHOG_AI_FEEDBACK_SURVEY_ID',
  'VITE_POSTHOG_AI_FEEDBACK_QUESTION_ID',
  'VITE_YM_WEBVISOR',
]);
const EXAMPLE = /example/i;

/** 1. Completeness; example values only while the file is marked as a template. */
export function configErrors(config, components) {
  const errors = [];
  if (typeof config.template !== 'boolean') errors.push('template: true or false');
  const texts = {
    ...Object.fromEntries(
      Object.entries(config.company ?? {}).map(([k, v]) => [`company.${k}`, v]),
    ),
    governingLaw: config.governingLaw,
    jurisdiction: config.jurisdiction,
    'billing.taxNote': config.billing?.taxNote,
  };
  for (const k of [
    'legalName',
    'productName',
    'address',
    'registration',
    'vatId',
    'representative',
    'email',
    'privacyEmail',
  ])
    if (!(`company.${k}` in texts)) errors.push(`company.${k}: missing`);
  for (const [k, v] of Object.entries(texts)) {
    if (typeof v !== 'string' || !v.trim()) errors.push(`${k}: empty`);
    else if (!config.template && EXAMPLE.test(v)) errors.push(`${k}: still an example value`);
  }
  const age = config.age ?? {};
  if (!Number.isInteger(age.minimum) || age.minimum < 13 || age.minimum > 21)
    errors.push('age.minimum: 13 to 21 (16 = GDPR default, 13 = COPPA)');
  if (typeof age.b2bOnly !== 'boolean') errors.push('age.b2bOnly: true or false');
  for (const id of DOC_IDS) {
    const d = config.documents?.[id];
    if (!d?.title || !d.version) errors.push(`documents.${id}: needs title and version`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d?.effective ?? ''))
      errors.push(`documents.${id}.effective: YYYY-MM-DD`);
  }
  for (const k of ['withdrawalDays', 'creditsRefundDays'])
    if (!Number.isInteger(config.refunds?.[k])) errors.push(`refunds.${k}: a number of days`);
  const ids = new Set();
  for (const p of config.processors ?? []) {
    const at = `processors.${p.id}`;
    if (!p.id || ids.has(p.id)) errors.push(`${at}: missing or duplicate id`);
    ids.add(p.id);
    if (!components.some((c) => c.id === p.component))
      errors.push(`${at}: component ${p.component} is not in config/components.json`);
    if (!CATEGORIES.has(p.category)) errors.push(`${at}: category one of ${[...CATEGORIES]}`);
    for (const k of ['name', 'purpose', 'data']) if (!p[k]) errors.push(`${at}.${k}: empty`);
    if (!config.template && EXAMPLE.test(p.name)) errors.push(`${at}.name: still an example value`);
    for (const c of p.cookies ?? [])
      if (!c.name || !c.purpose || !c.duration)
        errors.push(`${at}: cookies need name, purpose, duration`);
  }
  return errors;
}

/** 2. Nothing the stack uses is missing from the catalog. */
export function coverageErrors(config, { viteKeys, clearedCookies, privacyTools }) {
  const processors = config.processors ?? [];
  const errors = [];
  const envKeys = new Set(processors.flatMap((p) => p.env ?? []));
  for (const k of viteKeys)
    if (!envKeys.has(k) && !SETTINGS.has(k))
      errors.push(`${k} (apps/web/src): a tool? add it to a processor's env in config/legal.json`);
  const cookies = processors.flatMap((p) => (p.cookies ?? []).flatMap((c) => c.name.split(/,\s*/)));
  for (const prefix of clearedCookies)
    if (!cookies.some((c) => c.startsWith(prefix)))
      errors.push(
        `cookie ${prefix}* (cleared by the consent banner): not in the processor catalog`,
      );
  for (const tool of privacyTools)
    if (!processors.some((p) => `${p.id} ${p.name}`.toLowerCase().includes(tool.toLowerCase())))
      errors.push(`${tool} (docs/privacy.md per-tool table): not in the processor catalog`);
  return errors;
}

const sha = (doc) => createHash('sha256').update(JSON.stringify(doc.sections)).digest('hex');

/** 3. Each document's text hash, pinned per version. */
export function lockErrors(docs, lock) {
  return DOC_IDS.flatMap((id) => {
    const want = { version: docs[id].version, sha256: sha(docs[id]) };
    const have = lock[id];
    if (have?.version === want.version && have.sha256 === want.sha256) return [];
    const hint = `config/legal.lock.json: "${id}": ${JSON.stringify(want)}`;
    return have?.version === want.version
      ? [
          `${id}: the text changed under version ${want.version}; bump documents.${id}.version, then ${hint}`,
        ]
      : [`${id}: new version, record it in ${hint}`];
  });
}

/** Every processor on: what the lock hashes and what the page build must show. */
function everything(config, components) {
  const env = Object.fromEntries(
    config.processors.flatMap((p) => p.env ?? []).map((k) => [k, 'x']),
  );
  const answers = {
    components: Object.fromEntries(components.map((c) => [c.id, { mode: 'connect' }])),
  };
  return { env, used: config.processors.filter((p) => inUse(p, components, env, answers)) };
}

/** 4. Build the site with every browser tool on and check pages, links and the cookie list. */
function pageErrors(config, docs, env) {
  // Inside the repo: Astro moves files into the out dir, which fails across filesystems.
  const out = join(ROOT, 'node_modules/.cache/legal-site');
  rmSync(out, { recursive: true, force: true });
  try {
    execFileSync('pnpm', ['--filter', 'site', 'exec', 'astro', 'build', '--outDir', out], {
      cwd: ROOT,
      env: { ...process.env, ...env, ASTRO_TELEMETRY_DISABLED: '1', SITE_DEPLOY_ENV: 'none' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const errors = [];
    const html = (f) => readFileSync(f, 'utf8');
    const pages = [];
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f === 'index.html' || f === '404.html') pages.push(p);
      }
    };
    walk(out);
    for (const id of DOC_IDS) {
      const file = join(out, legalPath(id), 'index.html');
      if (!existsSync(file)) errors.push(`${legalPath(id)}: not built`);
      else if (!html(file).includes(`data-legal-version="${docs[id].version}"`))
        errors.push(`${legalPath(id)}: does not show version ${docs[id].version}`);
    }
    for (const p of pages) {
      const missing = DOC_IDS.filter((id) => !html(p).includes(`data-legal-link="${id}"`));
      if (missing.length) errors.push(`${p.slice(out.length)}: footer lacks ${missing.join(', ')}`);
    }
    const cookies = join(out, legalPath('cookies'), 'index.html');
    if (existsSync(cookies)) {
      const text = html(cookies).replaceAll('&amp;', '&').replaceAll('&quot;', '"');
      for (const p of config.processors.filter(
        (x) => ['analytics', 'marketing', 'functional'].includes(x.category) && x.env?.length,
      ))
        if (!text.includes(p.name)) errors.push(`cookie policy: does not list ${p.name}`);
    }
    return errors;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** 4 (web app): footers and sign-up link the pages; checked at runtime by e2e/legal.spec.ts. */
export function webErrors(files) {
  const errors = [];
  for (const id of DOC_IDS)
    if (!files['lib/legal.ts'].includes(`'${id}'`))
      errors.push(`apps/web/src/lib/legal.ts: no link to ${id}`);
  if (!files['pages/sign-in.tsx'].includes('<LegalLinks'))
    errors.push('apps/web/src/pages/sign-in.tsx: the auth footer has no <LegalLinks />');
  for (const id of ['terms', 'privacy'])
    if (!files['pages/sign-in.tsx'].includes(`legalUrl('${id}')`))
      errors.push(`apps/web/src/pages/sign-in.tsx: sign-up does not link ${id}`);
  if (!files['pages/shell.tsx'].includes('<LegalLinks'))
    errors.push('apps/web/src/pages/shell.tsx: the app footer has no <LegalLinks />');
  return errors;
}

/** 5. Marketing mail always carries the unsubscribe link and RFC 8058 headers. */
export async function emailErrors() {
  const { MARKETING_KINDS, TRANSACTIONAL_KINDS, renderEmail } = await import(
    '../apps/api/src/email.ts'
  );
  const errors = [];
  const both = TRANSACTIONAL_KINDS.filter((k) => MARKETING_KINDS.includes(k));
  if (both.length) errors.push(`email kinds both transactional and marketing: ${both}`);
  const links = {
    page: 'https://app.example.com/unsubscribe?token=t',
    oneClick: 'https://app.example.com/api/unsubscribe?token=t',
  };
  for (const kind of MARKETING_KINDS) {
    const mail = await renderEmail(kind, 'en', 'https://example.com', {}, links);
    if (!mail.text.includes(links.page)) errors.push(`email ${kind}: no unsubscribe link`);
    if (mail.headers?.['List-Unsubscribe'] !== `<${links.oneClick}>`)
      errors.push(`email ${kind}: no List-Unsubscribe header`);
    if (mail.headers?.['List-Unsubscribe-Post'] !== 'List-Unsubscribe=One-Click')
      errors.push(`email ${kind}: no List-Unsubscribe-Post header`);
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(read('config/legal.json'));
  const { components } = JSON.parse(read('config/components.json'));
  const plans = JSON.parse(read('config/plans.json'));
  const lock = JSON.parse(read('config/legal.lock.json'));
  const web = (f) => read(`apps/web/src/${f}`);
  const walk = (d) =>
    readdirSync(join(ROOT, d)).flatMap((f) =>
      statSync(join(ROOT, d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)],
    );
  const viteKeys = new Set(
    walk('apps/web/src').flatMap((f) => read(f).match(/VITE_[A-Z0-9_]+/g) ?? []),
  );
  const clearedCookies = [...web('lib/analytics.ts').matchAll(/\{ name: \/\^(\w+)\/ \}/g)].map(
    (m) => m[1],
  );
  const privacy = read('docs/privacy.md');
  const table = privacy.slice(
    privacy.indexOf('## Per-tool support'),
    privacy.indexOf('## Retention'),
  );
  const privacyTools = [...table.matchAll(/^\| ([A-Z][^|]*?)\s*\|/gm)]
    .map((m) => m[1])
    .filter((t) => t !== 'Tool')
    .flatMap((t) => t.replace(/\(.*\)/, '').split('/'))
    .map((t) => t.trim());
  const { env, used } = everything(config, components);
  const docs = legalDocs(config, used, plans);
  const errors = [
    ...configErrors(config, components),
    ...coverageErrors(config, { viteKeys, clearedCookies, privacyTools }),
    ...lockErrors(docs, lock),
    ...webErrors({
      'lib/legal.ts': web('lib/legal.ts'),
      'pages/sign-in.tsx': web('pages/sign-in.tsx'),
      'pages/shell.tsx': web('pages/shell.tsx'),
    }),
    ...(await emailErrors()),
  ];
  if (!process.argv.includes('--no-build') && !errors.length)
    errors.push(...pageErrors(config, docs, env));
  if (errors.length) {
    console.error(`check:legal (docs/legal.md):\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `check:legal: ${DOC_IDS.length} documents${config.template ? ' (TEMPLATE: have a lawyer review them)' : ''}, ${config.processors.length} processors, ${clearedCookies.length} consent cookies, ${privacyTools.length} data-map tools covered`,
  );
}
