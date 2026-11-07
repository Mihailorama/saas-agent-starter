#!/usr/bin/env node
// Lists models in config/ai-models.json without an explicit price (docs/billing.md). The gateway
// then uses LiteLLM's cost map (vendor APIs and aggregators) and refuses the model if that has no
// price either, unless it is "unmetered": true (limited by the plans' llmUsageMonthly instead of
// money). Warnings only: a template ships placeholders; deployments fix them.
import { readFileSync } from 'node:fs';

const { contours } = JSON.parse(
  readFileSync(new URL('../config/ai-models.json', import.meta.url), 'utf8'),
);
let warnings = 0;
for (const [contour, models] of Object.entries(contours)) {
  for (const m of models) {
    if (m.pricePer1kTokens) continue;
    warnings++;
    const id = `${contour}: ${m.provider}/${m.model}`;
    console.warn(
      m.unmetered === true
        ? `note: ${id} is unmetered: limited by llmUsageMonthly (calls/tokens), not by spend`
        : `warning: ${id} has no explicit price: LiteLLM's cost map must price it, or the gateway refuses it`,
    );
  }
}
console.log(`check:ai-prices: ${warnings} warning(s)`);
