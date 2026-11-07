# Marketing layer: site, SEO, social posting, rank tracking, GEO

Every product built on this template needs a public site, search visibility and social posting
from day one, kept separate from the app (owner decision, 2026-11-07). This is what ships, how to
run it and what to check before each release. Decision record:
[ADR 0021](adr/0021-marketing-layer.md); licenses: [LICENSES.md](LICENSES.md).

| Piece              | Where                                                       | Runs                                |
| ------------------ | ----------------------------------------------------------- | ----------------------------------- |
| Site + blog        | `apps/site` (Astro, static), content in `src/content/blog/` | `site` container or any static host |
| Lighthouse budgets | `apps/site/lighthouserc.cjs`, `.github/workflows/site.yml`  | CI on PRs touching the site         |
| Social posting     | Postiz, `docker compose --profile marketing`                | optional container                  |
| Rank tracking      | SerpBear, same profile                                      | optional container                  |
| Search Console     | `pnpm seo:report`                                           | local / scheduled, read-only        |
| Bing / IndexNow    | `pnpm seo:indexnow --since <last deployed sha>`             | after each site deploy              |
| AI answers (GEO)   | `pnpm geo:check`, questions in `config/geo.json`            | local, optional, no CI              |

## The site (`apps/site`)

Astro 7 (MIT), static output, no client framework: pages ship HTML and CSS, plus one small script
for analytics. Tokens and base styles are the web app's (`apps/web/src/index.css` is imported, not
copied), so both look the same and a token change lands in both.

```sh
pnpm --filter site dev        # http://localhost:4321, shows drafts
pnpm --filter site build      # apps/site/dist
docker compose up -d site     # nginx container on :8090 (SITE_PORT)
```

Astro 7 refuses to run on Node older than 22.23.4 (a check in its CLI), newer than the 22.18
the rest of the repo needs; CI and the `node:22-alpine` image already use the latest 22.x.

- **Settings** in `src/site.ts`: name, tagline, description, repository, organization data for
  schema.org. URLs come from env at build time: `SITE_URL` (canonical URL; a path in it, such as
  `https://owner.github.io/repo`, becomes Astro's `base`, so build links with `path()`/`abs()` from
  `src/site.ts`, never as bare `/...`), `SITE_APP_URL` (adds the "Sign in" link to the app; none
  without it), `SITE_OG_IMAGE` (absolute URL of a 1200x630 share image
  hosted outside git), `SITE_TWITTER`, `SITE_NOINDEX=true` for staging.
- **Blog**: one `.md` or `.mdx` file per post in `src/content/blog/`; the file name is the URL.
  Front matter: `title` (max 60), `description` (50-160), `pubDate`, `author`, optional
  `updatedDate`, `draft`, `faq`. The build fails when a field breaks the limits.
- **Media**: images and video are not stored in git (AGENTS.md). Host them on your CDN or object
  storage and use absolute URLs; the CSP allows `https:` images. Astro's image optimizer is off
  (it needs `sharp`, whose libvips is LGPL; ADR 0021).

### SEO built in

Every page gets, from `src/components/Seo.astro`: `<title>` and meta description, a canonical
URL on `SITE_URL`, `hreflang` alternates plus `x-default`, Open Graph and Twitter card tags,
and one schema.org JSON-LD graph (Organization and WebSite on every page; SoftwareSourceCode
and FAQPage on the home page; BlogPosting, plus FAQPage when a post has `faq`). Generated from the
content at build: `sitemap-index.xml` (`@astrojs/sitemap`), `robots.txt` (allows every crawler,
AI crawlers included; `SITE_NOINDEX=true` disallows all), `rss.xml`, `llms.txt`
([llmstxt.org](https://llmstxt.org) format: pages and posts with their descriptions) and, when
`INDEXNOW_KEY` is set, the IndexNow key file `/<key>.txt`. URLs end with a slash everywhere.

**Another language** (hreflang-ready): add the locale to `locales` in `src/site.ts`, put its pages
under `src/pages/<locale>/` (the default locale has no prefix), and pass the translations to
`<Base alternates={[{ lang: 'de', path: '/de/...' }]}>` on both versions. The sitemap integration
then adds `xhtml:link` alternates. Only list a translation that exists.

### Analytics on the site

The site runs the web app's `track()` and consent code unchanged
(`apps/web/src/lib/analytics.ts`, imported by `src/scripts/analytics.ts`), with the same
`VITE_*` env and the same rules ([product-analytics.md](product-analytics.md)): nothing loads
without env; PostHog/GA4 only after consent (the same vanilla-cookieconsent banner and regime
settings, `CONSENT_*` on the `site` container, plus a footer link to reopen the choices); Umami
cookieless. Page views use the path as the route. Links with `data-cta="<id>"` send
`site_cta_clicked` (catalogued in `config/events.json`, checked by `pnpm check:events`, which now
also scans `apps/site/src`). The journey `site-to-signup` in `config/journeys.json` (CTA click,
sign-up started, sign-up completed) works when the site and the app report to one PostHog project
on one parent domain (`example.com` + `app.example.com`: PostHog's cookie is shared across
subdomains). The container's CSP takes the sink origins from `ANALYTICS_ORIGINS`, like the web.

### Lighthouse CI

`.github/workflows/site.yml` builds the site with `SITE_URL=http://localhost:4321` and runs
Lighthouse CI three times per URL (`/`, `/blog/`, the example post) on every PR that touches the
site, its shared CSS/analytics or the event catalog. It fails when the median score drops below:
performance 0.90, accessibility 0.95, best practices 0.95, SEO 0.95. Reports are a workflow
artifact (`lighthouse-reports`), nothing is uploaded to a public server. Measured on this branch:
0.99 / 1 / 1 / 1. Locally: build with `SITE_URL=http://localhost:4321`, then
`pnpm --filter site lhci` (needs Chrome; `LHCI_PORT` for another port). Lighthouse CI runs through
`pnpm dlx`, not as a dependency (license note in [LICENSES.md](LICENSES.md)).

### The starter's own landing page (GitHub Pages)

The home page of `apps/site` is this repository's landing page (owner decision, 2026-11-07):
products built on the template replace `src/pages/index.astro` and the texts in `src/site.ts`.
Every claim on it must hold for the code on `main`; the "Also in 1.0" block lists open PRs
planned for 1.0.0, so drop any entry whose PR misses the release.

`.github/workflows/pages.yml` builds it with
`SITE_URL=https://mihailorama.github.io/saas-agent-starter` and deploys it with the official Pages
actions. It runs only on a published release or by hand: release-please's release workflow
dispatches it on `main` after each release (a release made with `GITHUB_TOKEN` starts no other
workflow, and the `github-pages` environment accepts the default branch only). Before the first
release, enable Pages with source "GitHub Actions" in the repository settings. Custom domain: set
the repository variable `PAGES_SITE_URL` (e.g. `https://starter.example.com`) and add the domain
in the Pages settings; nothing else changes.

## SEO checklist per release

Before a release that touches the site (most of it is enforced; the rest is a read):

1. CI `Site` workflow green (Lighthouse budgets) and `pnpm check:events` green.
2. New pages and posts: one `h1`, a title that says what the page answers, a description that
   would make you click, internal links from at least one existing page, images with `alt`.
3. A post that answers questions has an `faq` block; the answers repeat the visible text.
4. Changed URL? Keep the old one working (redirect at your proxy or CDN) and update internal
   links; the sitemap only lists the new one.
5. After deploy: `pnpm seo:indexnow --since <previous deployed sha>` (Bing and the other
   IndexNow engines), and in Search Console request indexing for the one or two most important
   new URLs (Google does not take IndexNow).
6. A week later: `pnpm seo:report` (new queries and pages), SerpBear for the tracked keywords,
   and `pnpm geo:check` for AI answers.

## Social posting with Postiz

[Postiz](https://github.com/gitroomhq/postiz-app) (AGPL-3.0, run unmodified) schedules posts to X,
LinkedIn, Bluesky, Mastodon, Reddit, Threads, YouTube, TikTok, Instagram, Facebook and more from
one calendar, with team approval and a public API.

```sh
docker compose --profile marketing up -d postiz     # UI http://localhost:4007 (POSTIZ_PORT)
```

It reuses this stack: database `postiz` on our Postgres (role and database made by the one-shot
`postiz-db`), Redis db 3, and our Temporal server in its own namespace `postiz` (one-shot
`postiz-namespace`; Postiz registers its two search attributes there on start, which works on
Temporal's SQL visibility, no Elasticsearch). Its own compose file starts a second Postgres, a
Redis, Temporal, Temporal's Postgres and Elasticsearch; none of them are needed here.

- First visit: register (the first account owns the workspace), then set
  `POSTIZ_DISABLE_REGISTRATION=true` and restart. Change `POSTIZ_JWT_SECRET` before exposing it.
- Channels: each network needs its own developer app; put the keys (`X_API_KEY`,
  `LINKEDIN_CLIENT_ID`, ...; list in [Postiz's docs](https://docs.postiz.com/providers)) in
  `.env.postiz` (gitignored, read by the container) and restart. Their OAuth redirect URLs use
  `MAIN_URL`, so on a server put Postiz behind HTTPS on its own host name.
- Workflow: draft in Postiz (or create posts through its public API from a release job), review
  in the calendar, schedule. Link to the site with UTM parameters so PostHog shows which channel
  brought the visit. A release note on the blog is the canonical text; social posts link to it.
- Weight: about 1.2 GiB RAM idle and a constant ~20 % of one CPU (Next.js frontend, NestJS
  backend and a Temporal worker in one container), plus ~100 MiB on Temporal (docs/STACK.md).
  That is twice the whole default app stack; Postiz's own
  [system requirements](https://docs.postiz.com/self-host/installation/system-requirements) say 2 GB /
  2 vCPU as the floor and 8 GB / 4 vCPU recommended. It fits the S server (8 CPU / 24 GB), but on
  a smaller one run it on a separate VM, or use Postiz's hosted plan. Permissive-only deliveries
  drop it (compose.permissive.yaml): post natively, or run Mixpost Lite (MIT) separately.

## Rank tracking with SerpBear

[SerpBear](https://github.com/towfiqi/serpbear) (MIT) tracks Google positions of your keywords per
country and device, with history, e-mail digests and optional Search Console data per keyword.

```sh
docker compose --profile marketing up -d serpbear   # UI http://localhost:3200 (SERPBEAR_PORT)
```

- Login `SERPBEAR_USER` / `SERPBEAR_PASSWORD`; set `SERPBEAR_PASSWORD`, `SERPBEAR_SECRET` and
  `SERPBEAR_APIKEY` to real values before exposing it. Data is SQLite in the `serpbear-data`
  volume.
- Ranks need a SERP source: in Settings pick a scraper API (SerpApi, ScrapingRobot, Serply,
  SpaceSerp, ...) or your own proxy. Without one, keywords are stored but positions stay at 0.
  That is an external paid or free-tier service; budget for it.
- Search Console per keyword: set `SERPBEAR_SEARCH_CONSOLE_CLIENT_EMAIL` and
  `SERPBEAR_SEARCH_CONSOLE_PRIVATE_KEY` from the same service account as `seo:report`.
- API: `Authorization: Bearer $SERPBEAR_APIKEY` reads keywords and domains
  (`GET /api/keywords?domain=example.com`); adding keywords is UI (or session) only.
- Maintenance: one maintainer, releases in bursts (3.1.0 in March 2026, 3.1.1-3.1.2 in late
  October 2026). If it stalls, the Search Console average position from `seo:report` is the free
  first-party fallback for your own site; competitor positions then need a paid SEO tool.

## Search Console (`pnpm seo:report`)

Pulls the last 28 days (`--days N`) ending three days ago (Search Console data lags) from the
[Search Analytics API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query):
totals (clicks, impressions, CTR, average position), top 10 queries and top 10 pages. `--json`
prints the raw responses.

1. Google Cloud: create a project, enable the "Google Search Console API", create a service
   account and a JSON key.
2. Search Console: Settings, Users and permissions, add the service account's e-mail (its
   `client_email`) as a user with Full permission. The script only requests the
   `webmasters.readonly` scope, so it cannot change anything.
3. Env: `GSC_SITE_URL` = the property exactly as in Search Console (`sc-domain:example.com` for a
   domain property, `https://example.com/` for a URL-prefix one) and `GSC_CREDENTIALS` = the key
   file path (or its JSON). Without them it prints the planned requests. Keep the key out of git
   and out of CI unless a protected secret holds it.

The script signs the service-account JWT with Node's `crypto`; no Google SDK is added.

## Bing Webmaster Tools and IndexNow

1. [Bing Webmaster Tools](https://www.bing.com/webmasters): sign in and add the site. Fastest:
   "Import from Google Search Console" (takes the verified sites and sitemaps); otherwise verify
   with the XML file, a meta tag or a DNS CNAME record, then submit `/sitemap-index.xml`.
2. IndexNow: pick a key (8-128 characters: `a-z`, `A-Z`, `0-9`, `-`) and set `INDEXNOW_KEY` for
   the site build; the site then serves it at `/<key>.txt`.
3. After every deploy of the site: `SITE_URL=https://example.com INDEXNOW_KEY=... pnpm
   seo:indexnow --since <previously deployed sha>` (after `pnpm --filter site build`). It maps the
   changed files to URLs (a post: the post, `/blog/`, `/`; a page: its URL; layouts, styles or
   config: every URL in the sitemap; deleted posts are submitted too so engines drop them) and
   sends one POST to `https://api.indexnow.org/indexnow`, which shares it with every IndexNow
   engine (Bing, Seznam, Naver, Yep and others). `200` means accepted, `202` accepted with
   the key still being verified; `403` the key file is missing or wrong, `422` URLs not on the
   host. `--dry-run` prints the request. No `--since`: every URL (first deploy).

Wire it into your deploy job with the previous release's sha; it needs no secret beyond the key,
which is public by design.

## GEO: visibility in AI answers (`pnpm geo:check`)

No mature open-source tool measures this, so the check is a small script. It asks each buyer
question in `config/geo.json` through the `claude` CLI (Claude Code) on your Claude
subscription with the model set there (`claude-opus-5-5`, passed as `--model`; there is no
default), with web search on by default, from an empty temp directory with no project
instructions, user settings or MCP servers, so the answer is what a buyer would get. For each
answer it records whether the product or an alias is named (case-sensitive), its rank among the
brands named (product plus `competitors`), and which links point at your `domains`. The report
goes to `dist/geo/<date>.md` (`--out <dir>` to keep a history elsewhere).

- Optional and manual: there is no CI job and no secret. It removes `ANTHROPIC_API_KEY` from the
  CLI's environment so it never bills an API key; log in to Claude Code once instead.
  `--dry-run` (or no `claude` on the PATH) prints the commands.
- Write questions as buyers ask them, without your product name; keep them stable so reports
  compare over time. A generic product name (like the template's "Workspace") needs a distinctive
  alias or it will never count.
- It measures one assistant (Claude) at one point in time; answers vary run to run. Treat it as
  a trend, and fix the inputs it reflects: clear pages, FAQ answers, `llms.txt`, third-party
  mentions.
- Example run on this branch (3 questions, web search on): mentioned 0/3 (expected for the
  placeholder product), competitors named: Asana 3, Notion 2, Linear 2, Trello 1.

## Ports and env

Host ports (all bound to 127.0.0.1): `SITE_PORT` 8090, `POSTIZ_PORT` 4007, `SERPBEAR_PORT` 3200.
Every variable is in `.env.example` (commented); social network keys for Postiz go in
`.env.postiz`.
