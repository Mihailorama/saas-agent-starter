#!/usr/bin/env node
// `pnpm check:budgets` (part of check:ts): three things that, when they change, change what every
// other check means. A rule written down only as prose gets broken; these are the same rules as
// a check (docs/quality.md).
//
// 1. Gate configs: lint, type, license and Lighthouse settings and the layout guards. A change
//    fails until the same change records the file's new hash in config/budgets.json, so weakening
//    a gate is always an explicit, reviewable line, never a side effect.
// 2. Suppressions (biome-ignore, @ts-expect-error, noqa, type: ignore, #[allow(...)], ...): the
//    count may not grow past `suppressionsMax`. Fix the code instead; raising the cap is the same
//    explicit line.
// 3. AGENTS.md size: agents read it on every task, and long instructions get followed worse.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const BUDGETS = 'config/budgets.json';
export const SUPPRESSION =
  /biome-ignore|eslint-disable|@ts-(expect-error|ignore|nocheck)|#\s*noqa|type:\s*ignore|pyright:\s*ignore|#!?\[allow\(/;
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|astro|py|rs)$/;

/** The parts of a file that are the gate: for pyproject.toml only the ruff and pyright tables. */
export function gateText(path, text) {
  if (!path.endsWith('pyproject.toml')) return text;
  return text
    .split(/^(?=\[)/m)
    .filter((t) => /^\[tool\.(ruff|pyright)/.test(t))
    .join('');
}

export const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Suppression lines in tracked code files: [{file, line, text}]. */
export function suppressions(files, read) {
  return files
    .filter((f) => CODE.test(f) && !f.startsWith('scripts/check-budgets'))
    .flatMap((file) =>
      read(file)
        .split('\n')
        .flatMap((text, i) =>
          SUPPRESSION.test(text) ? [{ file, line: i + 1, text: text.trim() }] : [],
        ),
    );
}

/** What is over budget: a list of messages, empty when everything holds. */
export function check(budgets, { read, files }) {
  const out = [];
  for (const [path, want] of Object.entries(budgets.gateFiles)) {
    const got = hash(gateText(path, read(path)));
    if (got !== want)
      out.push(
        `${path} changed (hash ${got}, recorded ${want}). If you meant to change a gate, record "${got}" in ${BUDGETS} and say why in the PR; never to make a check pass.`,
      );
  }
  const found = suppressions(files, read);
  if (found.length > budgets.suppressionsMax)
    out.push(
      `${found.length} suppressions, the cap is ${budgets.suppressionsMax}. Fix the code instead of silencing the check. All of them:\n${found.map((s) => `    ${s.file}:${s.line}  ${s.text.slice(0, 100)}`).join('\n')}`,
    );
  const size = Buffer.byteLength(read('AGENTS.md'));
  if (size > budgets.agentsMdMaxBytes)
    out.push(
      `AGENTS.md is ${size} bytes, the cap is ${budgets.agentsMdMaxBytes}. Move details to docs/ and keep a one-line pointer.`,
    );
  return out;
}

function main() {
  const budgets = JSON.parse(readFileSync(new URL(`../${BUDGETS}`, import.meta.url), 'utf8'));
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const problems = check(budgets, { read, files });
  if (problems.length) {
    console.error(`budgets (${BUDGETS}, docs/quality.md):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `budgets: ${Object.keys(budgets.gateFiles).length} gate configs unchanged, suppressions ${suppressions(files, read).length}/${budgets.suppressionsMax}, AGENTS.md ${Buffer.byteLength(read('AGENTS.md'))}/${budgets.agentsMdMaxBytes} bytes`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
