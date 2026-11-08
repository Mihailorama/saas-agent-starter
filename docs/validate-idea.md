# Validate a business idea before building it

A small, opt-in kit for testing an idea with Claude Code before writing product code: simulated
critique and buyers to find objections, wording and a price range, then real signals (a
waitlist page, a price survey, interviews) to measure demand. Nothing here runs in CI, adds a
dependency or vendors third-party code.

| Piece                      | Where                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| founder-skill plugin (MIT) | registered as marketplace `starter-founder` in `.claude/settings.json`, pinned by commit, **not enabled** |
| `/validate-idea <idea>`    | `.claude/commands/validate-idea.md`                                                                       |
| Private output             | `founder/` (gitignored)                                                                                   |
| Waitlist event             | `waitlist_joined` in `config/events.json`                                                                 |

## Install (each user, on purpose)

The plugin is registered but not enabled, so opening the repository never starts a run of 100
sub-agents. Claude Code registers the `starter-founder` marketplace once you trust the folder.
Then, in a session:

```text
/plugin install founder-skill@starter-founder
```

Pick **Install for you, in this repo only** (local scope: the entry goes to the gitignored
`.claude/settings.local.json`). From a shell instead:

```sh
claude plugin install founder-skill@starter-founder --scope local
```

The plugin is [Jakeschincariol/founder-skill](https://github.com/Jakeschincariol/founder-skill)
(MIT) at commit `fd9385b0cfe1b96bebce3898fbd506d73eff5a9d` (2026-10-06): 11 skills (board,
competitors, consumer panel, pricing, CFO, offer, marketing, launch, brand, ops, plan). Its
Python is stdlib only, with no hooks, no network calls of its own and no install-time code; it
writes to `founder/`. Installed as a plugin, its skills are namespaced:
`/founder-skill:founder-board`, `/founder-skill:founder-consumer` and so on. Review a newer
commit before moving the `sha` in `.claude/settings.json`; the upstream `/plugin marketplace add
Jakeschincariol/founder-skill` follows its default branch instead.

Remove it from the **Installed** tab of `/plugin`.

## Run

```text
/validate-idea team scheduling for dental clinics, sold to practice managers
```

It chains board, competitors, the consumer panel in quick mode (20 buyers), pricing (Van
Westendorp) and the CFO, then adds what the CFO skill lacks for a subscription business: churn,
CAC payback, LTV and MRR from the prices in `config/plans.json`, with the plan's
`llmSpendMonthly` cap as the worst-case AI cost per customer. It ends with
`founder/validation-plan.md`, a list of real-signal tasks, and gives no "fund" or "go" vote.

### Cost warning

The full consumer panel (`/founder-skill:founder-consumer` without `--quick`) starts 100
sub-agents, one per simulated buyer, plus the moderator. That is about 100 model contexts on
your subscription or API account in one run, and `founder-offer` re-tests on the panel again.
`/validate-idea` uses `--quick` (20) and asks before anything larger.

## What simulated output is good for

Good for objections, wording, missing features and a first price anchor. Bad as a demand
forecast: never read a simulated buy rate as a conversion rate.

- Agents built from demographic personas reach about 74% of human test-retest consistency
  ([arXiv:2411.10109](https://arxiv.org/abs/2411.10109)).
- The semantic similarity rating (SSR) method reaches about 90% on stated purchase intent, and
  stated intent is still not a purchase ([arXiv:2510.08338](https://arxiv.org/abs/2510.08338)).
- Synthetic answers are too uniform and change with the prompt wording
  ([Political Analysis, 2024](https://doi.org/10.1017/pan.2024.5)).
- Nielsen Norman Group: synthetic users can help prepare research, but "user research needs
  real users" ([NN/g](https://www.nngroup.com/articles/synthetic-users/)).

## From simulated output to real signals

`founder/validation-plan.md` holds four tasks, each with a threshold you set before launch:

1. **Landing/waitlist page** in `apps/site` (docs/marketing.md): the buyers' wording, one price,
   a CTA with `data-cta="waitlist_join"` (sends `site_cta_clicked`); joining sends
   `waitlist_joined` with only the page `variant` (e.g. `pro_29`), never the email. Run two
   variants with different prices to test willingness to pay.
2. **Van Westendorp survey** in PostHog for waitlist sign-ups (the four price questions), in
   the surveys-as-code format of `config/journeys.json` (docs/product-analytics.md). Feed the
   answers back to `/founder-skill:founder-pricing` as a CSV (`too_cheap, cheap, expensive,
   too_expensive`): real answers replace the simulated ones.
3. **Customer interviews** booked through Cal.diy and recorded in Twenty
   ([crm.md](crm.md)): 5 to 10 conversations about past behaviour, built from the panel's
   objections.
4. **Draft `config/plans.json` change** (docs/billing.md), reviewed and applied by a human
   after the survey and the interviews.

Waitlist funnel: no `waitlist` journey is added to `config/journeys.json` yet. Journey steps
are bare event names, so a first step "visited the landing page" would count every page view in
the site and the app, and the conversion alert would fire before the page exists. Read the
funnel in PostHog (`page_view` with the landing path, `site_cta_clicked` with
`cta = waitlist_join`, `waitlist_joined`), or add the journey once the format supports step
filters.

## Alternatives, ranked

1. [Jakeschincariol/founder-skill](https://github.com/Jakeschincariol/founder-skill) (MIT): the
   pick. Covers board, competitors, panel, pricing and CFO in one plugin, stdlib Python, no
   hooks. Lacks SaaS metrics (added by `/validate-idea`).
2. [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) (MIT):
   pricing strategy and customer research skills; good for the page and interview guide, no
   panel or unit economics.
3. [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)
   (Apache-2.0): general product and research plugins; broader, less idea-specific.
4. [garrytan/gstack](https://github.com/garrytan/gstack) (MIT): `office-hours` and
   `plan-ceo-review` are strong critiques of an idea, but it installs hooks and updates itself,
   so it is listed here only and not registered.
5. [microsoft/TinyTroupe](https://github.com/microsoft/TinyTroupe) (MIT): a Python library for
   persona simulations; for building your own panel, not a Claude Code plugin.
