#!/usr/bin/env node
// License gate for every ecosystem: JS (pnpm), Python (uv + pip-licenses), Rust
// (cargo-deny, also RustSec advisories). Fails on anything outside ALLOWED.
// Infra container images must be listed in docs/LICENSES.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'PostgreSQL',
  'Python-2.0',
  // File-level copyleft only; see docs/adr/0005-license-policy.md (we never modify dependency files).
  'MPL-2.0',
]);
// Non-SPDX strings some Python packages publish, mapped to SPDX ids.
const ALIASES = {
  'MIT License': 'MIT',
  '3-Clause BSD License': 'BSD-3-Clause',
  // The PSF License Agreement is the operative part of the Python-2.0 license stack.
  'PSF-2.0': 'Python-2.0',
};

/** Splits an SPDX expression on a top-level operator (outside parentheses). */
function split(expr, op) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') depth--;
    else if (depth === 0 && expr.startsWith(` ${op} `, i)) {
      parts.push(expr.slice(start, i));
      start = i + op.length + 2;
    }
  }
  return [...parts, expr.slice(start)];
}

export function allowed(expr) {
  const e = expr.trim();
  if (ALIASES[e]) return ALLOWED.has(ALIASES[e]);
  const or = split(e, 'OR');
  if (or.length > 1) return or.some(allowed);
  const and = split(e, 'AND');
  if (and.length > 1) return and.every(allowed);
  if (e.startsWith('(') && e.endsWith(')')) return allowed(e.slice(1, -1));
  return ALLOWED.has(e);
}

const bad = [];
const mpl = []; // allowed, but listed so the file-level copyleft deps stay visible
const isMpl = (license) => /MPL-2\.0|Mozilla Public License 2\.0/.test(license);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1e8 });

// JS: every installed package, dev included.
const js = JSON.parse(run('pnpm', ['licenses', 'list', '--json']));
let jsCount = 0;
for (const [license, pkgs] of Object.entries(js)) {
  jsCount += pkgs.length;
  if (!allowed(license)) bad.push(...pkgs.map((p) => `js  ${p.name}@${p.versions} (${license})`));
  else if (isMpl(license)) mpl.push(...pkgs.map((p) => `js  ${p.name}@${p.versions} (${license})`));
}

// Python: everything in the worker venv, tooling included. A PEP 639 License-Expression
// is authoritative; otherwise the declared License field or the trove classifiers must pass
// (the field is often an SPDX id like `Apache-2.0` while the classifier is the vaguer
// `Apache Software License`; free-text fields fall back to the classifiers).
const py = JSON.parse(
  run(
    'uv',
    ['run', '--locked', 'pip-licenses', '--format=json', '--from=all', '--with-system'],
    'services/worker-py',
  ),
);
const known = (v) => v && v !== 'UNKNOWN';
// A classifier naming a disallowed copyleft/source-available family vetoes an allowed-looking
// field. MPL 2.0 is allowed; MPL 1.x is not.
const copyleft =
  /GPL|MPL 1\.|Mozilla Public License 1\.|EUPL|SSPL|Server Side|Business Source|Commons Clause/i;
for (const p of py) {
  const expr = p['License-Expression'];
  const [field, classifier] = [p['License-Metadata'], p['License-Classifier']];
  const ok = known(expr)
    ? allowed(expr)
    : !copyleft.test(classifier) && [field, classifier].some((l) => known(l) && allowed(l));
  const shown = known(expr) ? expr : `${p['License-Metadata']} / ${p['License-Classifier']}`;
  if (!ok) bad.push(`py  ${p.Name}@${p.Version} (${shown})`);
  else if (isMpl(shown)) mpl.push(`py  ${p.Name}@${p.Version} (${shown})`);
}

// Images: each must be documented with its license.
const licensesDoc = readFileSync('docs/LICENSES.md', 'utf8');
const dockerfiles = ['apps/api', 'apps/web', 'services/worker-py'].map((d) => `${d}/Dockerfile`);
const images = new Set(
  [
    ...readFileSync('docker-compose.yml', 'utf8').matchAll(/^\s*image:\s*(\S+)/gm),
    ...dockerfiles.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/^FROM\s+(\S+)/gm)]),
  ].map((m) => m[1].split(':')[0]),
);
const stages = new Set(
  dockerfiles.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/ AS (\S+)/g)].map((m) => m[1])),
);
for (const image of images) {
  if (!stages.has(image) && !licensesDoc.includes(`\`${image}\``)) {
    bad.push(`img ${image} (not listed in docs/LICENSES.md)`);
  }
}

console.log(`js: ${jsCount} packages, python: ${py.length} packages, images: ${images.size}`);
if (mpl.length) console.log(`MPL-2.0 (allowed, unmodified):\n  ${mpl.join('\n  ')}`);

// Rust: cargo-deny applies the same allowlist (deny.toml) and RustSec advisories.
const rust = spawnSync('cargo', ['deny', '--log-level', 'error', 'check'], { stdio: 'inherit' });
if (rust.status !== 0) bad.push('rust: cargo deny check failed (see above)');

if (bad.length) {
  console.error(`Disallowed or undocumented licenses:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('license check: 0 disallowed (js, python, rust, images)');
