# 0021. Marketing layer: static site, SEO tooling, Postiz, SerpBear, GEO check

Status: accepted (owner decision, 2026-11-07)

## Context

Every product built on the template needs SEO and social posting from day one, kept separate
from the app: a public site and blog that search engines and AI assistants can read, a way to
schedule social posts, rank tracking, Search Console and Bing data, and some measure of whether
AI answers mention the product. The app (React SPA behind auth) is the wrong place for public,
crawlable pages, and none of this should add code dependencies outside the license policy
(ADR 0005) or a second analytics vendor (ADR 0012).

## Decision

- **Site: Astro 7 (MIT), static output, in `apps/site`.** Mainstream static site generator with
  content collections (typed Markdown/MDX front matter), official sitemap/RSS/MDX integrations
  and i18n routing; ships HTML with no client framework, so Lighthouse budgets are easy to hold.
  It imports the web app's `index.css` (same tokens, Tailwind 4) and `analytics.ts` (same
  `track()`, consent rule and sinks) instead of copying them. SEO is built into one `Seo.astro`
  head component (canonical, hreflang, OG/Twitter, JSON-LD) plus generated `sitemap-index.xml`,
  `robots.txt`, `rss.xml`, `llms.txt` and the IndexNow key file. Served by its own nginx
  container (64 MiB limit) or any static host.
- **No `sharp`:** Astro's optional image optimizer bundles libvips (LGPL-3.0-or-later), which
  the code gate rejects. `ignoredOptionalDependencies: [sharp]` keeps it out of the install and
  the site uses the passthrough image service; media is hosted outside git anyway.
- **Lighthouse CI (Apache-2.0)** in `.github/workflows/site.yml` on PRs touching the site:
  median of 3 runs per URL, fails below performance 0.90 / accessibility, best practices, SEO
  0.95. It runs through `pnpm dlx` and is not a devDependency, because `lighthouse` depends on
  `@sentry/node` 11 and through it on the FSL-licensed `sentry` CLI (same issue as the API's
  Sentry SDK, docs/LICENSES.md). That is CI tooling that ships nothing, like the GitHub Actions
  we pin; the gate itself is unchanged.
- **Postiz (AGPL-3.0, unmodified container) for social posting**, profile `marketing`: the most
  used open-source scheduler (41k GitHub stars, 31 releases in 2026, latest v2.25.3 on 2026-10-24), many networks,
  public API. It reuses our Postgres (own role and database), Redis (db 3) and Temporal (own
  namespace; its search attributes work on SQL visibility), instead of the five extra services
  of its own compose file. The permissive twin disables it.
- **SerpBear (MIT, unmodified container) for rank tracking**, same profile: light (SQLite, ~70
  MiB idle), API, Search Console per keyword. Needs an external SERP scraper API for positions.
- **Search Console and IndexNow as two small scripts** (`pnpm seo:report`, `pnpm seo:indexnow`)
  on Node's `fetch` and `crypto`: one read-only Search Analytics summary with a service account,
  one IndexNow POST of the URLs changed since the last deploy. No Google or IndexNow SDK.
- **GEO check as a script** (`pnpm geo:check`): no mature open-source tool exists. It runs buyer
  questions through the `claude` CLI on a subscription with the model from `config/geo.json`
  (required, `claude-opus-5-5`), in a neutral context, and writes a dated Markdown report.
  Optional and manual: no CI job, no secret, `ANTHROPIC_API_KEY` stripped from its environment.
- **Analytics stays ADR 0012:** the site reports to the same PostHog/Umami project as the app,
  with one new catalogued event (`site_cta_clicked`) and one journey (`site-to-signup`).

## Measured (2026-11-07, `docker stats`, this repo's compose, 8-core shared host)

- `site` (nginx): 7 MiB. Lighthouse on the built site: 0.99 / 1 / 1 / 1.
- Postiz v2.25.3: ~1.23 GiB idle (3 min after start, no traffic), ~1.35 GiB after a smoke test
  (register, one draft through the API), a constant ~18-28 % of one CPU at rest; our Temporal
  went from ~80-120 MiB to ~228 MiB with its workers. Postiz's own docs: 2 GB / 2 vCPU floor
  for an all-in-one install, 8 GB / 4 vCPU recommended.
- SerpBear 3.1.2: ~71 MiB idle, ~176 MiB after the smoke test (login, domain, keyword).

## Alternatives

- Next.js for the site: AGENTS.md forbids Next/Vercel-specific code. Hugo (Apache-2.0) and
  Eleventy (MIT) are good static generators but would not share the TypeScript analytics code
  and Tailwind setup as directly. Serving marketing pages from the SPA: not crawlable enough.
- Mixpost Lite (MIT, Laravel) instead of Postiz: permissive and lighter, but needs MySQL, covers
  fewer networks, and its last release was March 2026. It is the permissive replacement in
  docs/LICENSES.md, not shipped. Postiz's hosted plan is the option when the server is small.
- Rank tracking SaaS (Ahrefs, Semrush): better data, paid, not self-hosted. Search Console's
  average position (`seo:report`) covers our own pages for free.
- `googleapis` npm SDK for Search Console: hundreds of files for one POST; a signed JWT is 10
  lines of `crypto`.
- A GEO SaaS (prompt tracking across assistants): paid, an external processor of our questions;
  revisit if a mature open-source option appears.

## Consequences

- Postiz is heavy for what it does (about twice the default app stack in RAM, with steady idle
  CPU). It is opt-in; on a small server run it on a separate VM or use the hosted plan.
- SerpBear has one maintainer and bursty releases (March, then late October 2026). If it stalls,
  drop it for Search Console positions plus a paid tool for competitors.
- Astro 7's CLI needs Node 22.23.4 or newer, above the repo's 22.18 floor; only the site needs it.
- The GEO check reflects one assistant at one time; it is a trend indicator, not a ranking.
