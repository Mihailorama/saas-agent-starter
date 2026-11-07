#!/usr/bin/env node
// License gate for every ecosystem: JS (pnpm), Python (uv + pip-licenses), Rust
// (cargo-deny, also RustSec advisories). Fails on anything outside ALLOWED.
// Infra container images must be listed in docs/LICENSES.md.
// `--notices <file>` also writes THIRD_PARTY_NOTICES.md (used by `pnpm sbom`).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const ALLOWED = [
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
  // Permissive (owner decision 2026-11-07): Zlib (numpy's bundled parts), CNRI-Python (regex).
  'Zlib',
  'CNRI-Python',
  // File-level copyleft only; see docs/adr/0005-license-policy.md (we never modify dependency files).
  'MPL-2.0',
];
// Exact (trimmed) non-SPDX strings in package metadata that name an allowed license, mapped to
// SPDX. Anything else must be a valid SPDX expression; unknown or ambiguous strings fail (e.g.
// "BSD", or "Apache Software License", which does not say which version).
export const ALIASES = {
  'MIT License': 'MIT',
  // Trove classifier; it does not say 2- or 3-clause, both are allowed.
  'BSD License': 'BSD-3-Clause',
  '3-Clause BSD License': 'BSD-3-Clause',
  'Apache 2.0': 'Apache-2.0',
  'Apache License 2.0': 'Apache-2.0',
  'Apache License, Version 2.0': 'Apache-2.0',
  'ISC License': 'ISC',
  'ISC License (ISCL)': 'ISC',
  'Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0',
  // The PSF License Agreement is the operative part of the Python-2.0 license stack.
  'PSF-2.0': 'Python-2.0',
};
const run = (cmd, args, opts) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1e8, ...opts });

/**
 * Map of license string -> allowed? Aliases first, then the SPDX expression is parsed by
 * `license-expression` (scripts/spdx-allowed.py, worker venv) in one batch.
 */
export function verdicts(licenses) {
  const strings = [...new Set(licenses)];
  const expressions = strings.map((l) => ALIASES[l.trim()] ?? l.trim());
  const out = run(
    'uv',
    ['run', '--locked', '--project', 'services/worker-py', 'python', 'scripts/spdx-allowed.py'],
    {
      cwd: new URL('..', import.meta.url),
      input: JSON.stringify({ allowed: ALLOWED, expressions }),
    },
  );
  const ok = JSON.parse(out);
  return new Map(strings.map((l, i) => [l, ok[i] === true]));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

function main() {
  const bad = [];
  const inventory = []; // [ecosystem, name, version, license] for the notices file
  const mpl = []; // allowed, but listed so the file-level copyleft deps stay visible
  const isMpl = (license) => /MPL-2\.0|Mozilla Public License 2\.0/.test(license);

  // JS: every installed package, dev included.
  const js = JSON.parse(run('pnpm', ['licenses', 'list', '--json']));
  // Python: everything in the worker venv, tooling included. A PEP 639 License-Expression
  // is authoritative; otherwise the declared License field or the trove classifiers must pass
  // (the field is often an SPDX id like `Apache-2.0` while the classifier is the vaguer
  // `Apache Software License`; free-text fields fall back to the classifiers). Several
  // classifiers (joined by "; ") must all pass.
  const py = JSON.parse(
    run('uv', ['run', '--locked', 'pip-licenses', '--format=json', '--from=all', '--with-system'], {
      cwd: 'services/worker-py',
    }),
  );
  const known = (v) => v && v !== 'UNKNOWN';
  const classifiers = (p) =>
    known(p['License-Classifier']) ? p['License-Classifier'].split('; ') : [];
  const ok = verdicts([
    ...Object.keys(js),
    ...py
      .flatMap((p) => [p['License-Expression'], p['License-Metadata'], ...classifiers(p)])
      .filter(known),
  ]);

  let jsCount = 0;
  for (const [license, pkgs] of Object.entries(js)) {
    jsCount += pkgs.length;
    for (const p of pkgs) inventory.push(['npm', p.name, p.versions.join(', '), license]);
    if (!ok.get(license)) bad.push(...pkgs.map((p) => `js  ${p.name}@${p.versions} (${license})`));
    else if (isMpl(license))
      mpl.push(...pkgs.map((p) => `js  ${p.name}@${p.versions} (${license})`));
  }

  // A classifier naming a disallowed copyleft/source-available family vetoes an allowed-looking
  // field. MPL 2.0 is allowed; MPL 1.x is not.
  const copyleft =
    /GPL|MPL 1\.|Mozilla Public License 1\.|EUPL|SSPL|Server Side|Business Source|Commons Clause/i;
  for (const p of py) {
    const expr = p['License-Expression'];
    const [field, classifier] = [p['License-Metadata'], p['License-Classifier']];
    const cls = classifiers(p);
    const pass = known(expr)
      ? ok.get(expr)
      : !copyleft.test(classifier) &&
        ((known(field) && ok.get(field)) || (cls.length > 0 && cls.every((c) => ok.get(c))));
    const shown = known(expr) ? expr : `${field} / ${classifier}`;
    inventory.push(['PyPI', p.Name, p.Version, shown]);
    if (!pass) bad.push(`py  ${p.Name}@${p.Version} (${shown})`);
    else if (isMpl(shown)) mpl.push(`py  ${p.Name}@${p.Version} (${shown})`);
  }

  // Images: each must be documented with its license.
  const licensesDoc = readFileSync('docs/LICENSES.md', 'utf8');
  const dockerfiles = [
    'apps/api',
    'apps/web',
    'apps/site',
    'services/worker-py',
    'infra/backup',
  ].map((d) => `${d}/Dockerfile`);
  const images = new Set(
    [
      ...[
        'docker-compose.yml',
        'compose.permissive.yaml',
        'compose.prod.yaml',
        'compose.backup.yaml',
      ].flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/^\s*image:\s*([^\s$]\S*)/gm)]),
      ...dockerfiles.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/^FROM\s+(\S+)/gm)]),
    ].map((m) => m[1].split(':')[0]),
  );
  const stages = new Set(
    dockerfiles.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/ AS (\S+)/g)].map((m) => m[1]),
    ),
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

  const noticesAt = process.argv.indexOf('--notices');
  if (noticesAt > 0) {
    const meta = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--locked']));
    for (const p of meta.packages) {
      if (p.source) inventory.push(['crates.io', p.name, p.version, p.license ?? 'see crate']);
    }
    const rows = inventory
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
      .map((r) => `| ${r.join(' | ')} |`);
    const images = licensesDoc.slice(
      licensesDoc.indexOf('| Image'),
      licensesDoc.indexOf('\n\n', licensesDoc.indexOf('| Image')),
    );
    writeFileSync(
      process.argv[noticesAt + 1],
      `# Third-party notices\n\nGenerated by \`pnpm run sbom\` (scripts/license-check.mjs). Code dependencies (runtime and dev tooling, used unmodified) and the container images the stack runs. Full component lists per image: the CycloneDX SBOMs next to this file.\n\n## Code dependencies (${inventory.length})\n\n| Ecosystem | Package | Version | License |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n## Container images (run unmodified, not distributed with the app)\n\n${images}\n`,
    );
    console.log(`wrote ${process.argv[noticesAt + 1]} (${inventory.length} code dependencies)`);
  }

  if (bad.length) {
    console.error(`Disallowed or undocumented licenses:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log('license check: 0 disallowed (js, python, rust, images)');
}
