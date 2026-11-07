#!/usr/bin/env node
// `pnpm seo:indexnow [--since <git-ref>] [--dry-run]`, run after a site deploy: tells Bing and the
// other IndexNow engines which URLs changed (docs/marketing.md). Changed URLs come from the git
// diff since the last deployed revision; a change to shared code (layouts, styles, config) or no
// --since means every URL in the built sitemap (apps/site/dist). Env: SITE_URL, INDEXNOW_KEY
// (the site serves it as /<key>.txt). Without them, or with --dry-run, it prints the request.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://api.indexnow.org/indexnow';
const SITEMAP = 'apps/site/dist/sitemap-0.xml';
// Files that change many pages at once.
const SHARED = /^(apps\/site\/(src|public)\/|apps\/site\/astro\.config|apps\/web\/src\/index\.css)/;

/** Route of a page file (pages/index.astro -> /, pages/blog/index.astro -> /blog/, x.astro -> /x/). */
function pageRoute(file) {
  const m = file.match(/^apps\/site\/src\/pages\/([^[\]]+)\.astro$/);
  return m && `/${m[1].replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/');
}

/**
 * URLs touched by the changed files. `changes` is [status, path] from `git diff --name-status`;
 * `all` is every URL of the built site (sitemap), or undefined when there is no build.
 */
export function changedUrls(changes, siteUrl, all) {
  const abs = (path) => new URL(path, siteUrl).href;
  const urls = new Set();
  const deleted = new Set();
  let everything = false;
  for (const [status, file] of changes) {
    const post = file.match(/^apps\/site\/src\/content\/blog\/(.+)\.mdx?$/);
    const own = post ? `/blog/${post[1]}/` : pageRoute(file);
    if (own) urls.add(abs(own));
    if (own && status.startsWith('D')) deleted.add(abs(own)); // engines should drop it
    if (post) for (const list of ['/blog/', '/']) urls.add(abs(list));
    // Endpoints (pages/*.ts: rss, robots, llms.txt) are not pages to submit.
    if (!own && SHARED.test(file) && !/\/pages\/.*\.ts$/.test(file)) everything = true;
  }
  if (everything && all) for (const u of all) urls.add(u);
  // Drafts and pages that are not built are not submitted; deleted ones are.
  return [...urls].filter((u) => !all || all.includes(u) || deleted.has(u)).sort();
}

export function body(siteUrl, key, urlList) {
  const host = new URL(siteUrl).host;
  return { host, key, keyLocation: new URL(`/${key}.txt`, siteUrl).href, urlList };
}

function main(argv) {
  const since = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : undefined;
  const { SITE_URL: siteUrl, INDEXNOW_KEY: key } = process.env;
  if (!siteUrl) throw new Error('set SITE_URL (the deployed site origin)');
  const all = existsSync(SITEMAP)
    ? [...readFileSync(SITEMAP, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    : undefined;
  const changes = since
    ? execFileSync('git', ['diff', '--name-status', since, 'HEAD'], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.split('\t')[0], l.split('\t').at(-1)])
    : [['M', 'apps/site/src/site.ts']]; // no baseline: everything
  if (!since && !all) throw new Error(`no --since and no ${SITEMAP}: build the site first`);
  const urls = changedUrls(changes, siteUrl, all);
  if (!urls.length) return console.log('indexnow: no site URL changed');
  const payload = body(siteUrl, key ?? '<INDEXNOW_KEY>', urls.slice(0, 10_000));
  if (!key || argv.includes('--dry-run')) {
    return console.log(`dry run: POST ${ENDPOINT} ${JSON.stringify(payload, null, 2)}`);
  }
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  }).then((r) => {
    // 200 = accepted, 202 = accepted while the key is being verified.
    console.log(`indexnow: HTTP ${r.status} for ${urls.length} URL(s)`);
    if (r.status >= 300) process.exitCode = 1;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .catch((e) => {
      console.error(`seo:indexnow: ${e.message}`);
      process.exit(1);
    });
}
