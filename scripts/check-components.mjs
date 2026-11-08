#!/usr/bin/env node
// Component catalog rail (docs/setup.md, ADR 0032): every compose.prod.yaml profile and every key
// of deploy/env/example.env (commented ones too) belongs to a component in
// config/components.json, so `pnpm run infra` can set it up and `infra add` can offer it. Fails CI
// otherwise: a new component ships with its catalog entry.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODES = new Set(['install', 'connect', 'skip']);

export function checkComponents(components, profiles, keys, exists = () => true) {
  const errors = [];
  const ids = new Set();
  const owned = new Set();
  const ownedProfiles = new Set();
  for (const c of components) {
    const at = `component ${c.id}`;
    if (!/^[a-z][a-z0-9-]*$/.test(c.id ?? '') || ids.has(c.id))
      errors.push(`${at}: bad or duplicate id`);
    ids.add(c.id);
    if (!['core', 'optional'].includes(c.tier)) errors.push(`${at}: tier is core or optional`);
    if (!c.description) errors.push(`${at}: needs a description`);
    if (!c.modes?.length || c.modes.some((m) => !MODES.has(m))) errors.push(`${at}: bad modes`);
    if (c.modes?.includes('install') && typeof c.install?.ramMiB !== 'number')
      errors.push(`${at}: install needs ramMiB (docs/STACK.md)`);
    if (c.install?.profile) {
      ownedProfiles.add(c.install.profile);
      if (!profiles.includes(c.install.profile))
        errors.push(`${at}: profile ${c.install.profile} is not in compose.prod.yaml`);
    }
    if (c.install?.after && !exists(c.install.after))
      errors.push(`${at}: ${c.install.after} missing`);
    for (const [k, t] of Object.entries(c.install?.env ?? {})) {
      owned.add(k);
      for (const [, n] of t.matchAll(/\{hex:(\d*)\}/g))
        if (!(Number(n) >= 16)) errors.push(`${at}: ${k} needs {hex:N} with N >= 16`);
    }
    if (c.install?.site && !(c.install.site in (c.install.env ?? {})))
      errors.push(`${at}: site ${c.install.site} is not in install.env`);
    for (const f of c.connect ?? []) {
      owned.add(f.key);
      if (!f.key || !f.prompt || typeof f.secret !== 'boolean')
        errors.push(`${at}: connect fields need key, prompt and secret`);
      try {
        new RegExp(f.validate ?? '');
      } catch {
        errors.push(`${at}: ${f.key} validate is not a regex`);
      }
    }
    for (const k of c.keys ?? []) owned.add(k);
    for (const r of Object.values(c.requires ?? {}).flat()) {
      if (!components.some((o) => `${o.id}:install` === r || `${o.id}:connect` === r))
        errors.push(`${at}: requires unknown ${r}`);
    }
  }
  for (const p of profiles)
    if (!ownedProfiles.has(p)) errors.push(`compose.prod.yaml profile ${p}: no component`);
  for (const k of keys) if (!owned.has(k)) errors.push(`deploy/env/example.env ${k}: no component`);
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL('..', import.meta.url).pathname;
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const { components } = JSON.parse(read('config/components.json'));
  const profiles = [
    ...new Set(
      [...read('compose.prod.yaml').matchAll(/^\s+profiles: \[([^\]]+)\]/gm)].flatMap((m) =>
        m[1].split(',').map((p) => p.trim()),
      ),
    ),
  ];
  const keys = [...read('deploy/env/example.env').matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map(
    (m) => m[1],
  );
  const errors = checkComponents(components, profiles, keys, (f) => existsSync(join(root, f)));
  if (errors.length) {
    console.error(`check:components failed (config/components.json):\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `check:components: ${components.length} components, ${profiles.length} profiles, ${keys.length} env keys`,
  );
}
