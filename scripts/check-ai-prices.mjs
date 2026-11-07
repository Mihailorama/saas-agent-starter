#!/usr/bin/env node
// Warns about models in config/ai-models.json without a price (docs/billing.md). The AI gateway
// refuses them unless they are marked "unmetered": true, and unmetered calls are not counted
// against LLM spend limits. Warnings only: a template ships placeholders; deployments fix them.
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
        ? `warning: ${id} is unmetered: its calls are not limited by plan LLM spend limits`
        : `warning: ${id} has no price: the AI gateway refuses it (set pricePer1kTokens or "unmetered": true)`,
    );
  }
}
console.log(`check:ai-prices: ${warnings} warning(s)`);
