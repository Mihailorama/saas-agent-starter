---

description: Stress-test a business idea with the founder-skill plugin, add SaaS unit economics, and turn it into a plan for real demand signals
argument-hint: <one-line idea and target customer>
---

Validate the idea `$ARGUMENTS` before anything is built. Read docs/validate-idea.md first; it
says what simulated output is good for (objections, wording, price anchors) and what it is not
(a demand forecast). Done means `founder/validation-plan.md` exists with the real-signal tasks
of step 7. Do not end with a "fund", "go" or "no-go" vote, and do not present any simulated
number as evidence of demand.

0. Check that the `founder-skill` plugin is installed (`/plugin` lists it; installed as a plugin
   its skills are namespaced: `/founder-skill:founder-board` and so on). If it is not, stop and
   show the install commands from docs/validate-idea.md. Never install it yourself.
   Everything the skills write goes to `founder/` (gitignored: the idea is private). Never copy
   it into a tracked file, a commit, an issue or a PR.
1. `/founder-board`: the idea, scored through its three framework lenses, and what would kill
   it. Keep the risks and the questions; drop the vote.
2. `/founder-competitors`: competitors, substitutes and their public prices, every fact linked.
3. `/founder-consumer --quick`: 20 simulated buyers, not 100 (the full panel starts 100
   sub-agents; run it only if the user asks for it after reading the cost warning). Keep the
   objections, the words buyers used and what would flip a no. Report buy rates only as
   "simulated", next to the limits in docs/validate-idea.md.
4. `/founder-pricing`: the Van Westendorp range from the panel's answers, against competitor
   prices. It is a hypothesis for the real survey in step 7, not a price decision.
5. `/founder-cfo`: unit economics as the skill builds them.
6. SaaS step (the CFO skill has no subscription metrics). Write `founder/saas.md`:
   - Prices: every plan and currency from `config/plans.json` (`plans.<id>.prices.<currency>.amount`,
     `interval`), plus the candidate price from step 4 as an extra column.
   - Variable cost per paying organization per month: the plan's `llmSpendMonthly` cap is the
     worst-case AI cost; add payment fees (ask the user for the rate, or use 3% and say so) and
     hosting per organization (ask; docs/STACK.md has the measured memory of the stack).
   - Ask the user for, or mark as assumptions: monthly logo churn, CAC per paying customer, paying
     customers at month 3, 6 and 12, free-to-paid conversion.
   - Compute with a script (`python3 -c ...`), never in your head, and show the inputs next to
     each result: ARPA, gross margin per customer = ARPA - variable cost, MRR at month 3/6/12,
     LTV = gross margin / monthly churn, LTV:CAC, CAC payback in months = CAC / gross margin,
     and the paying customers needed to cover fixed monthly costs from step 5.
   - A sensitivity table: churn 3/5/8%, price at the low and high end of step 4's range.
7. Real-signal tasks. Write `founder/validation-plan.md` with these four, each with the exact
   files to touch, the success threshold the user sets before launch, and how to read the result:
   - **Landing/waitlist page draft** in `apps/site` (docs/marketing.md): the value proposition
     in the buyers' own words from step 3, one price from step 4, and a waitlist call to action
     with `data-cta="waitlist_join"` (sends `site_cta_clicked`). Joining sends
     `track('waitlist_joined', { variant })` with the page variant id only, never the email
     (`config/events.json`). New page: behind a flag (`config/flags.json`, `apps/site/src/flags.ts`),
     `<Base>` for the SEO head, no media in git. Draft the page; build it only if the user asks.
   - **Van Westendorp survey in PostHog**: the four price questions (too cheap, a bargain,
     getting expensive, too expensive) shown to waitlist sign-ups, in the surveys-as-code format
     of `config/journeys.json` (docs/product-analytics.md). Draft the entry in the plan; do not
     edit `config/journeys.json` unless the user asks. Run `/founder-pricing` again on the real
     answers (it reads a CSV with `too_cheap, cheap, expensive, too_expensive`).
   - **Customer interviews**: a Cal.diy event type for a 20-minute interview and Twenty as the
     record of who was interviewed (docs/crm.md, `book_interview` as the CTA id), 5 to 10
     interviews, an interview guide built from step 3's objections (past behaviour, not
     opinions about the idea), and what answer would change the plan.
   - **Draft `config/plans.json` change** as a diff in the plan, not applied: price amounts per
     currency, `providerPriceId` left as a placeholder, `version` bumped (docs/billing.md). A
     human reviews and applies it after the survey and interviews.
8. Reply with: the top five objections, the SaaS numbers with their assumptions, the four tasks
   and their thresholds, and the path to `founder/validation-plan.md`.

Rules: never quote, imitate or speak as a real person, and do not describe the skills as trained
on or as any named person; refer to them as framework lenses. Simulated buyers are not
customers: never write "customers said". Ask before running anything that costs more than the
quick panel.
