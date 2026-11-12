---

description: Climb the UI council's score - screenshot, let several models score it, fix, repeat until every one rates every category at the target
argument-hint: <what to improve, e.g. "the settings screens">
---

Improve the UI (`$ARGUMENTS`, or the whole app when empty) until the UI council passes. Read
docs/ui.md "UI council" first. Done means a round where `pnpm ui:council` exits 0, with the
round table from `apps/web/.visual/council/report.md` in the PR description.

1. Start a climb: `pnpm ui:council -- --reset --members <cheapest member>`. If the user named
   products to beat, ask them to drop screenshots into
   `apps/web/.visual/references/<product>/*.png` first (never commit them, never fetch someone
   else's app yourself).
2. Read the findings of the round. Fix what more than one round or member keeps raising first.
   Only `components/ui`, `components/patterns`, tokens in `src/index.css` and DESIGN.md (UI
   rules in AGENTS.md); copy follows the copy rules. Do not change a screen just to look
   different: every change needs a finding behind it.
3. `pnpm --filter web visual` must stay green (declare changed screens in `apps/web/.visual-intent`),
   then run the next round with the same members. Repeat.
4. When the cheap member passes (exit 2), add the next member with `--members a,b`, and so on;
   the whole council (exit 0) is the finish line.
5. Stop and report instead of looping when: 8 rounds without a pass, the same lowest category
   three rounds in a row with no change, or a member errors twice. Say which findings you could
   not resolve and why.
6. Never tell a member the target, never edit `history.json` or the scores, never lower `target`
   or remove a category, a member or a reference to pass. Commit the code, not the screenshots.
