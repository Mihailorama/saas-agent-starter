# Legal and compliance baseline

What every product built from the starter gets by default to avoid the common launch mistakes:
legal pages, acceptance at sign-up, age self-attestation, marketing consent with one-click
unsubscribe, honest billing, and a gate (`pnpm check:legal`) that keeps them in step with the
code.

**This is engineering, not legal advice.** The texts are templates generated from configuration.
They do not make a product compliant with any law, and nothing here may claim that it does. A
lawyer must review them for every country the product is sold in.

## What is covered

| Area                                                   | Where                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Privacy policy, terms, refunds, cookies, business info | `config/legal.json` -> `apps/site/src/legal.ts` -> `/legal/<doc>/` on the public site                      |
| Footer links                                           | every site page (`Base.astro`), the sign-in/sign-up pages and the app sidebar (`LegalLinks`)               |
| Acceptance at sign-up and of new versions              | `/accept-terms` in the web, `/api/legal` in the API, enforced in `requireRole` and on org endpoints        |
| Minimum age                                            | `age.minimum` in `config/legal.json`, a required checkbox at sign-up; none when `age.b2bOnly`              |
| Marketing email consent                                | opt-in checkbox at sign-up (never pre-ticked), switch in Settings, Privacy; `user.marketing_opt_in`        |
| Unsubscribe                                            | link in every marketing mail + `List-Unsubscribe` / `List-Unsubscribe-Post` (RFC 8058), `/api/unsubscribe` |
| No hidden fees, no dark patterns                       | billing page shows price, period, taxes note, renewal date; cancel as short as subscribe (docs/ui.md)      |
| Cookie consent banner                                  | already there: `apps/web/src/lib/analytics.ts` (docs/product-analytics.md#consent)                         |
| Data export and deletion                               | already there: Settings, Privacy (docs/privacy.md, ADR 0022)                                               |
| Accessibility (alt text, contrast, keyboard)           | already there: axe on every page, layout guards (docs/ui.md)                                               |
| Licensed code, fonts and images                        | already there: the license gate (docs/LICENSES.md, ADR 0005); no media in git                              |
| No fake reviews or unsupported claims                  | already there: marketing rules (AGENTS.md "Marketing rules", copy rules in docs/ui.md)                     |

## Configure it

1. Edit `config/legal.json`: company legal name, address, registration and VAT numbers,
   representative, contact and privacy email, governing law and courts, minimum age (16 is the
   GDPR default; 13 where only COPPA applies) or `b2bOnly`, refund windows, the taxes note, and
   the names of your hosting and mail providers in `processors`.
2. Run `pnpm check:legal`. Each changed document prints a new line for `config/legal.lock.json`:
   bump that document's `version` (a date is fine), then paste the line. A text never changes
   under a version users already accepted.
3. Have a lawyer review the generated pages (build the site: `pnpm --filter site dev`, then
   `/legal/privacy/` and the others). Only then set `"template": false`: the gate then refuses
   example values (anything containing "example") and the pages drop the template notice.
   A site that is not the product itself (this repository's own site, say) can keep the template in
   `config/legal.json` and set its entity at build time instead: `SITE_LEGAL_JSON` is a JSON object
   whose top-level keys replace the config's, whose `company` is merged field by field and whose
   `processors` entries are merged by `id` (`"processors": [{"id": "hosting", "name": "..."}]`)
   (GitHub Pages: repo variable `PAGES_LEGAL_JSON`). It changes only the public pages, not the
   versions users accept in the app. With `"template": false` the build fails while any company
   field or the name of a processor the pages list still contains "example": the gate in step 2
   only sees `config/legal.json`, so the build checks what the override produces.
   When hosting and providers are agreed per customer contract (enterprise or managed
   deployments, no fixed provider list), set `"processorsByContract": true` instead: the privacy
   policy then says each organization's contract and data processing agreement set where it runs
   and who processes its data, including services the organization brings itself (its own
   database, cloud services, AI or GPU providers), lists none, and the build requires no
   provider names.

4. Set `VITE_SITE_URL` (the web links the pages there) and build the site with the web's `VITE_*`
   values and the deployment's `SITE_DEPLOY_ENV` (below).

## What is generated

Nothing in the policies lists tools by hand. The catalog of what the stack _can_ use is
`processors` in `config/legal.json` (one entry per tool: component, purpose, data, cookies, the
`env` keys that turn a browser tool on, and the component `modes` in which the server uses it).
A page lists a processor when:

- in the browser: all its `env` keys are set in the site build (the same `VITE_*` the web is
  built with; the tool only loads then);
- on the server: its component's mode in `deploy/setup/<SITE_DEPLOY_ENV>.answers.json` (the
  `pnpm run infra` answers, no secrets) is one of its `modes` (any mode but `skip` for a tool
  without `env`). PostHog, for example, is listed for the worker's AI events when `analytics` is
  connected even if the web has no PostHog key. Without an answers file only `core` counts.

The refund policy has a section per pricing model in `config/plans.json` (subscriptions, usage,
prepaid credits, contracts; docs/billing.md), plus the consumer withdrawal note unless `b2bOnly`.
The billing page builds its taxes, renewal and cancellation sentence the same way, from the
organization's provider, plan models and whether the viewer can cancel (`lib/billing-terms.ts`).

The lists of tools in use (the privacy policy's providers table, the cookie table and the consent
list) follow the deployment and are **not part of the accepted version**: turning a tool on or off
changes them without asking users again, and `config/legal.lock.json` hashes the rest of the text
only. If your law or your contracts require notice of a new subprocessor, bump the privacy
version when you add one.

`pnpm check:legal` keeps the catalog honest: every `VITE_*` key the web reads is a processor's
`env` or a known setting; every cookie the consent banner clears is in a processor's `cookies`;
every tool of the docs/privacy.md per-tool table has a processor; every component of
`config/components.json` has a processor or says `"processor": false` (vault, ops, pii); and every
place that builds the web or the site (both Dockerfiles, docker-compose.yml, release.yml,
pages.yml) passes every browser tool's env key, so the site's pages list what the app runs. An
empty extraction (a renamed heading, a reformatted file) fails too. e2e/legal.spec.ts collects the
cookies a sign-up sets and fails on one the catalog does not list, and checks the session cookie
lasts `sessionDays` (which auth.ts uses as the session lifetime).

## Acceptance

Every path that creates a user (email code, SSO, a sign-up from an invitation link) ends on
`/accept-terms`: the terms and privacy policy (one required checkbox with links), the age (a
required checkbox unless `b2bOnly`) and product news (optional, unticked). The API stores
`terms_version`, `privacy_version`, `legal_accepted_at`, `age_confirmed_at`,
`marketing_opt_in`, `marketing_opt_in_at` and `locale` (mail language, from the browser) on the
user (migration 0015, expand only). Users from before the migration see the same neutral first
step ("Before you continue").

Until the stored versions equal the config's, tenant routes answer 403 `legal acceptance
required` and Better Auth's organization endpoints 403 `LEGAL_ACCEPTANCE_REQUIRED`; the web
sends the user to `/accept-terms`, both on navigation and from any API call that gets this 403
(a version published while a tab is open). A new `version` of the terms or the privacy policy
therefore asks every user again (the marketing choice is kept). Exempt: data-subject rights (the
`/accept-terms` page links Settings, Privacy, which stays open to export and delete; leaving an
organization), API keys (machine credentials whose organization accepted through a person), and
an operator viewing as a user (read-only).

The account row exists before acceptance (Better Auth creates it with the first code or the SSO
callback) but cannot be used until then; accounts that never accept are ordinary users for the
privacy deletion flow.

## Marketing mail

`MARKETING_KINDS` in `apps/api/src/email.ts` lists the non-transactional templates
(`product-update` is the example). Send them only with `sendMarketingEmail(userId, kind, url,
campaign)` (`apps/api/src/legal.ts`): it sends nothing unless the user opted in and has a verified
address, writes in the user's language, adds the unsubscribe link and the RFC 8058 headers, and
the worker checks the opt-in again right before each delivery attempt (an unsubscribe between
the two wins, retries included) and passes only those two extra headers.

The link opens `/unsubscribe` in the web (one button, no sign-in); mail clients post to
`/api/unsubscribe` directly. Both flip `marketing_opt_in` off. The endpoint is rate-limited per
token, not per IP: one-click POSTs arrive from the mail providers' shared addresses. The token
is the user id with an HMAC under a key derived (HKDF) from `BETTER_AUTH_SECRET`. When you rotate
that secret, set `BETTER_AUTH_PREVIOUS_SECRET` to the old one until old mails no longer matter;
an invalid link says so and points to Settings, Privacy. Transactional mail (sign-in codes,
invitations, export notices) is never affected.

One-click unsubscribe also needs the DKIM signature to cover `List-Unsubscribe` and
`List-Unsubscribe-Post` (RFC 8058 section 4). Whether it does depends on your mail provider's
signing (docs/email.md): check a received message's `DKIM-Signature: h=` list.

## What a lawyer must still review

- Every generated text, against the countries and customers you sell to; the legal bases in the
  privacy policy (docs/privacy.md has generic notes only).
- Whether the minimum age, consumer withdrawal and refund windows fit your market.
- Processor agreements (DPAs) with each provider the privacy policy lists, and transfer
  safeguards for those outside your users' region.
- The cookie banner's regime per country (opt-in vs opt-out, docs/product-analytics.md#consent).
- Anything specific to your product: regulated data (health, finance, children), AI-specific
  duties (docs/ai-act.md), sector rules.
- Translations: the pages and the acceptance step are English only.

## Jurisdiction notes (orientation only)

- **GDPR (EU/EEA, UK GDPR)**: controller identity and contact, purposes and legal bases,
  processors, transfers, retention, rights and the right to complain must be in the privacy
  notice (Art. 13). Consent for marketing and non-essential cookies must be opt-in and as easy to
  withdraw as to give. Art. 8 sets the age of digital consent at 16, which member states may lower
  to 13. Some countries require a business-details page (Germany's Impressum).
- **CCPA/CPRA (California)**: a privacy policy with categories collected, purposes, sale/share
  disclosure and rights (know, delete, correct, opt out); "Do Not Sell or Share" handling if any
  tool counts as sharing; the consent banner's opt-out regime and Global Privacy Control
  (`respectGpc`) are the relevant pieces here. COPPA applies to children under 13.
- **Russia, 152-FZ**: personal data of Russian citizens must be stored first in databases in
  Russia (localisation; the RU contour, docs/llm-providers.md), processing usually needs written
  or explicit consent with specific content, a published policy on processing is mandatory, and
  operators register with Roskomnadzor. The templates here do not cover this; treat it as a
  separate review.
