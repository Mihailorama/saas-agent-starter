# EU AI Act: what the AI layer helps with, and what it does not

This is engineering documentation, not legal advice. The AI layer (ADR
[0008](adr/0008-ai-layer.md)) gives you records, labels and review controls that several
obligations of the EU AI Act ([Regulation (EU) 2024/1689](https://eur-lex.europa.eu/eli/reg/2024/1689/oj))
rely on. It does not make a product compliant. Whether and how an obligation applies depends
on your role (provider or deployer), the purpose of the system and its risk class, which only
you can assess.

Article references follow the Act as amended by the Digital Omnibus on AI,
[Regulation (EU) 2026/1744](https://eur-lex.europa.eu/eli/reg/2026/1744/oj) (published
24 July 2026, in force 27 July 2026). It moved the application of the high-risk requirements
(Chapter III, Sections 1 to 3) to **2 December 2027** for Annex III systems and
**2 August 2028** for Annex I systems. Check the consolidated text before relying on any date.

## Mapping

| Article                                        | What it asks (short)                                                                                                                                                                                                                                                                                                                    | What this starter provides                                                                                                                                                                                                                                                                                         | Where                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Art. 4, AI literacy                            | Providers and deployers take measures to support the AI literacy of staff and others operating AI systems on their behalf.                                                                                                                                                                                                              | A public page explaining each AI use, its data, its models and how to contest a result, generated from config, that you can point staff and users to. Training itself is yours.                                                                                                                                    | `/ai-transparency`, `config/ai-transparency.json`     |
| Art. 12, record-keeping (high-risk)            | High-risk systems technically allow automatic recording of events over their lifetime, for traceability.                                                                                                                                                                                                                                | One append-only `ai_calls` row per model call (who, when, purpose, model and exact version reported, prompt template version, tokens, cost, latency, outcome, trace id), content in S3 with recorded expiry, OTel spans.                                                                                           | `worker/ai.py`, `ai_calls` table                      |
| Art. 26, deployer obligations (high-risk)      | Among others: use per instructions, assign human oversight, monitor, and keep the automatically generated logs under your control for a period appropriate to the purpose, at least six months unless other law says otherwise (Art. 26(6)).                                                                                            | The logs above, an org-admin view with filters and a JSONL export for auditors. Default content retention is 180 days (`AI_CONTENT_RETENTION_DAYS`, enforced daily); rows stay until a deleted organization's record period ends (docs/privacy.md).                                                                       | `/ai-calls`, `GET /api/orgs/:orgId/ai-calls[/export]` |
| Art. 13, transparency to deployers (high-risk) | Providers give deployers instructions for use: purpose, accuracy limits, oversight measures, log interpretation.                                                                                                                                                                                                                        | Pieces of it: the model registry, the transparency page and the system card template below. The instructions themselves are a document you write.                                                                                                                                                                  | `config/ai-models.json`, this file                    |
| Art. 50, transparency for certain AI systems   | Inform people they interact with an AI system (50(1)); providers of generative systems mark synthetic output in a machine-readable way (50(2)); deployers disclose AI-generated text published to inform the public on matters of public interest, unless it underwent human review and someone holds editorial responsibility (50(4)). | A visible "AI-generated" badge on AI output, linked to the transparency page; the review state shows whether a human confirmed or corrected it. No machine-readable watermark: if you are a provider of a generative system, 50(2) marking is still on you.                                                        | `components/ai-badge.tsx`                             |
| Art. 14, human oversight (high-risk)           | Designed so that natural persons can oversee the system, understand its limits, disregard or override its output.                                                                                                                                                                                                                       | AI results are stored as `generated` and can be confirmed or corrected by a person; both actions are audit-logged with the reviewer and time; the original output stays retrievable via `ai_call_id`.                                                                                                              | `POST /api/projects/:id/ai-summary/{confirm,correct}` |
| Art. 15, accuracy and robustness (high-risk)   | Appropriate accuracy, declared accuracy metrics, resilience to errors, monitoring of feedback loops.                                                                                                                                                                                                                                    | Versioned prompts with an eval gate before release (`pnpm eval:real`, golden set per purpose); in production every call goes to PostHog AI observability or Langfuse, where online LLM-as-a-judge evaluators and user feedback score it. Helps you measure and declare accuracy; metrics and thresholds are yours. | `evals/`, `prompts/`, PostHog / Langfuse              |
| Art. 72, post-market monitoring (high-risk)    | Providers actively collect and analyse data on performance throughout the system's lifetime, under a monitoring plan.                                                                                                                                                                                                                   | The data side of such a plan: per prompt version and model, generations, judge scores and user feedback in PostHog or Langfuse; error and cost alerts in Prometheus. The plan itself is a document you write.                                                                                                      | PostHog / Langfuse, `infra/otel/alerts.yml`           |

## Still the deployer's (or provider's) job

- **Role and risk classification.** Decide whether you are a provider or a deployer for each
  AI use, and whether it is prohibited (Art. 5), high-risk (Art. 6 and Annex III), subject only
  to Art. 50, or none of these. The example purpose here (summarizing a project description)
  is not an Annex III use; yours may be.
- **Impact assessments.** A GDPR DPIA (GDPR Art. 35) where processing is likely to result in a
  high risk to people's rights; a fundamental rights impact assessment (AI Act Art. 27) if you
  are a deployer covered by that article.
- **Registration** in the EU database (Art. 49) if a system is high-risk and the article
  applies to you.
- **GDPR.** Lawful basis, information to data subjects, processor agreements with model
  providers, international transfers, data minimization in prompts, erasure requests (prompt
  and response objects contain personal data if users type it), and a retention period you can
  justify. Export, erasure and content retention are built in (docs/privacy.md): the daily
  `privacy-retention` schedule deletes content after `AI_CONTENT_RETENTION_DAYS`, the rows stay.
- **Quality, risk management, technical documentation, accuracy testing, post-market
  monitoring** for high-risk systems. The LLM-ops loop (ADR 0009) gives you evals, online judge
  scores, user feedback and alerts to feed them; the processes and documents are not code here.
- **Quality tools are processors.** PostHog Cloud receives call metadata (and prompt/output text
  only if `POSTHOG_PRIVACY_MODE=false`); an online LLM-as-a-judge in PostHog or Langfuse sends
  inputs and outputs to the judge model's provider. Cover them in your DPIA, records of
  processing and processor agreements; for the RU contour or clients that forbid transfers use
  self-hosted Langfuse only.
- **Staff training** for Art. 4.

## RU contour

Set `AI_CONTOUR=ru` for deployments serving Russia. The EU AI Act does not govern them;
Russian law does, notably Federal Law No. 152-FZ "On Personal Data", including Art. 18(5):
when collecting personal data of Russian citizens, the operator records and stores it in
databases located in Russia (with the exceptions that article lists). Use an
in-country or self-hosted OpenAI-compatible endpoint (`OPENAI_BASE_URL`), register only those
models under `ru` in `config/ai-models.json`, and keep the database and the content bucket in
Russia. The gateway refuses models not registered for the current contour, so an EU model
cannot be called from the RU contour by mistake.

## AI system card template

Fill one in per AI purpose and keep it next to the code (for example `docs/ai/<purpose>.md`).

```markdown
# AI system card: <purpose id, e.g. project.summary>

- Owner (team, contact):
- Role under the AI Act (provider / deployer) and reasoning:
- Risk class (prohibited / high-risk with Annex III point / Art. 50 only / minimal) and reasoning:
- Intended purpose and users:
- Out of scope / must not be used for:
- Contours and models (from config/ai-models.json):
- Prompt template id and current version:
- Input data (fields, personal data categories) and legal basis:
- Output and where it is shown; how it is labeled:
- Human oversight: who reviews, how they confirm or correct, what happens to unreviewed output:
- Known limitations and failure modes; how accuracy was checked:
- Logging: ai_calls fields used, content retention, who can access the log:
- Quality: eval golden set (evals/<purpose>), gate score, judge prompt version, online evaluator
  thresholds, last eval result:
- How affected people can contest a result:
- DPIA / FRIA references, registration number if any:
- Last reviewed (date, by):
```
