# AI system card: support.triage

- Owner (team, contact): <deployer: support lead, contact>
- Role under the AI Act (provider / deployer) and reasoning: deployer of a general-purpose model
  for an internal support workflow; provider of the support tool to its own agents.
- Risk class and reasoning: minimal. It sorts support requests and drafts text for staff; it
  makes no decision about a person (Annex III does not list support triage). It does not talk
  to customers, so Art. 50 chatbot disclosure does not apply; the `/ai-transparency` page still
  lists it.
- Intended purpose and users: support agents. Classify a conversation (question, bug,
  feature_request, billing, spam), find a duplicate tracker item, draft an answer for questions.
- Out of scope / must not be used for: replying to customers without a human, deciding refunds or
  account actions, rating customers or agents.
- Contours and models: `support.triage` in `config/ai-models.json` (Anthropic models in `eu`); selected by `AI_SUPPORT_TRIAGE_PROVIDER` / `AI_SUPPORT_TRIAGE_MODEL`.
- Prompt template id and current version: `support.triage/system` v1, `support.triage/duplicate` v1
  (`prompts/`, pinned in `prompts/lock.json`).
- Input data and legal basis: the customer messages of one conversation (may contain contact data
  the customer typed) and the widget's request kind; for duplicates, the model's own title and
  summary plus titles of open tracker items. Basis: handling the customer's request.
- Output and where it is shown; how it is labeled: one private note in the Chatwoot conversation,
  headed "AI triage: <category> (<provider>/<model>)"; draft answers are marked "review before
  sending, not sent". Bug and feature items in the tracker carry the model's title and summary
  and say they were filed by the support triage.
- Human oversight: agents read every conversation; they send, edit or discard drafts, re-label the
  conversation and edit or close tracker items. Nothing reaches the customer without an agent,
  except the opt-in "resolved" message after a human closed the item.
- Known limitations and failure modes: misclassification (most likely bug vs question), a wrong
  or missed duplicate, a draft answer that states features the product lacks. Unparsable output
  becomes "unclassified" with a note asking a human. Checked with unit tests (fake model), manual
  runs and the golden set `evals/support.triage/` (judge `prompts/judge/support.triage.v1.md`).
- Logging: one `ai_calls` row per call under `SUPPORT_AI_ORG_ID` (purpose, model, prompt id and
  version, tokens, cost, trace id, `actor_id = chatwoot:<account>/<conversation>`); content in the
  `AI_CONTENT_BUCKET` S3 objects for `AI_CONTENT_RETENTION_DAYS`; visible to that org's admins.
- How affected people can contest a result: ask support; an agent sees the note and the
  conversation, and the contact address on `/ai-transparency` applies.
- DPIA / FRIA references, registration number if any: <deployer>
- Last reviewed (date, by): 2026-11-07, initial version with the feature
