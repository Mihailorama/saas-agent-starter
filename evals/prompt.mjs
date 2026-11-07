// Promptfoo prompt function: the versioned system prompt from prompts/ (PROMPT_ID,
// PROMPT_VERSION, set by scripts/eval.mjs from the config's `gate.prompt`) plus the user
// message exactly as the worker sends it, stored in the dataset as `input`.
import { readFileSync } from 'node:fs';

export default function prompt({ vars }) {
  const { PROMPT_ID, PROMPT_VERSION } = process.env;
  const file = new URL(`../prompts/${PROMPT_ID}.v${PROMPT_VERSION}.md`, import.meta.url);
  return [
    { role: 'system', content: readFileSync(file, 'utf8').trim() },
    { role: 'user', content: vars.input },
  ];
}
