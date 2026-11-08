#!/usr/bin/env node
// Feature-flag rail (docs/feature-flags.md): every flag checked in code is a literal name from
// config/flags.json, and every catalog entry has a description, owner, boolean default and expiry
// date. Fails on unknown or non-literal names and bad entries; warns on expired or unused flags.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// isEnabled()/useFlag() in TS, is_enabled() in the Python worker. Method calls (`x.isEnabled(`,
// e.g. PostHog's own API inside the wrappers) and definitions are not flag checks.
const CALL = /(?<![.\w])(isEnabled|useFlag|is_enabled)\(\s*/g;

/**
 * Pure check: `flags` from config/flags.json, `sources` as [path, text] pairs, `linked`: flags
 * that PostHog surveys are linked to (config/journeys.json), which count as used.
 */
export function checkFlags(
  flags,
  sources,
  today = new Date().toISOString().slice(0, 10),
  linked = [],
) {
  const errors = [];
  const warnings = [];
  const used = new Set(linked.filter((n) => Object.hasOwn(flags, n)));
  for (const [name, f] of Object.entries(flags)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) errors.push(`catalog: bad flag name "${name}"`);
    for (const key of ['description', 'owner']) {
      if (typeof f[key] !== 'string' || !f[key].trim())
        errors.push(`catalog: ${name} lacks ${key}`);
    }
    if (typeof f.default !== 'boolean')
      errors.push(`catalog: ${name}.default must be true or false`);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(f.expires ?? '') && new Date(`${f.expires}T00:00:00Z`);
    if (!date || date.toISOString().slice(0, 10) !== f.expires) {
      errors.push(`catalog: ${name}.expires must be a date (YYYY-MM-DD)`);
    } else if (f.expires < today) {
      warnings.push(
        `flag "${name}" expired on ${f.expires} (owner ${f.owner}): finish the rollout, remove it`,
      );
    }
  }
  for (const [file, text] of sources) {
    for (const m of text.matchAll(CALL)) {
      const at = m.index + m[0].length;
      const line = text.slice(0, at).split('\n').length;
      const before = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).trim();
      if (/^(\/\/|\*|#)/.test(before) || /\b(function|def)$/.test(before)) continue;
      const name = text.slice(at).match(/^(['"])([^'"\n]+)\1/)?.[2];
      if (!name) errors.push(`${file}:${line}: ${m[1]}() needs a literal flag name`);
      else if (!Object.hasOwn(flags, name))
        errors.push(`${file}:${line}: flag "${name}" is not in config/flags.json`);
      else used.add(name);
    }
  }
  const unused = Object.keys(flags).filter((n) => !used.has(n));
  if (unused.length) {
    warnings.push(`flags declared but never checked in code (remove them): ${unused.join(', ')}`);
  }
  return { errors, warnings, used };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('..', import.meta.url).pathname;
  const { flags } = JSON.parse(readFileSync(join(root, 'config/flags.json'), 'utf8'));
  const files = (dir, ext) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? files(join(dir, d.name), ext) : ext.test(d.name) ? [join(dir, d.name)] : [],
    );
  const sources = [
    ...files('apps/web/src', /\.tsx?$/),
    ...files('apps/site/src', /\.(ts|astro)$/),
    ...files('apps/api/src', /\.ts$/),
    ...files('services/worker-py/worker', /\.py$/),
  ].map((f) => [f, readFileSync(join(root, f), 'utf8')]);
  const { surveys = [] } = JSON.parse(readFileSync(join(root, 'config/journeys.json'), 'utf8'));
  const linked = surveys.map((s) => s.flag);
  const { errors, warnings, used } = checkFlags(flags, sources, undefined, linked);
  for (const w of warnings) console.warn(`check:flags warning: ${w}`);
  if (errors.length) {
    console.error(`check:flags failed:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `check:flags: ${used.size} flags checked in code or linked to surveys, ${Object.keys(flags).length} catalogued`,
  );
}
