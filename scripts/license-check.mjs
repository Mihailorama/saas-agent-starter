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
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1e8 });

// JS: every installed package, dev included.
const js = JSON.parse(run('pnpm', ['licenses', 'list', '--json']));
let jsCount = 0;
for (const [license, pkgs] of Object.entries(js)) {
  jsCount += pkgs.length;
  if (!allowed(license)) bad.push(...pkgs.map((p) => `js  ${p.name}@${p.versions} (${license})`));
}

// Python: everything in the worker venv, tooling included.
const py = JSON.parse(
  run(
    'uv',
    ['run', '--locked', 'pip-licenses', '--format=json', '--from=mixed', '--with-system'],
    'services/worker-py',
  ),
);
for (const p of py) {
  if (!allowed(p.License)) bad.push(`py  ${p.Name}@${p.Version} (${p.License})`);
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

// Rust: cargo-deny applies the same allowlist (deny.toml) and RustSec advisories.
const rust = spawnSync('cargo', ['deny', '--log-level', 'error', 'check'], { stdio: 'inherit' });
if (rust.status !== 0) bad.push('rust: cargo deny check failed (see above)');

if (bad.length) {
  console.error(`Disallowed or undocumented licenses:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('license check: 0 disallowed (js, python, rust, images)');
