#!/usr/bin/env node
// Analytics rail (docs/product-analytics.md): every track() call uses a literal event name from
// config/events.json and only the props declared for it; every journey step is a catalogued
// event. Fails CI otherwise, so a feature cannot ship events nobody can find in the catalog.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const { events } = JSON.parse(readFileSync(join(root, 'config/events.json'), 'utf8'));
const { journeys } = JSON.parse(readFileSync(join(root, 'config/journeys.json'), 'utf8'));
const TYPES = new Set(['string', 'number', 'boolean']);
const errors = [];
const used = new Set();

for (const [name, e] of Object.entries(events)) {
  if (!/^[a-z][a-z0-9_]{0,48}$/.test(name)) errors.push(`catalog: bad event name "${name}"`);
  if (typeof e.description !== 'string' || !e.description)
    errors.push(`catalog: ${name} lacks a description`);
  if (typeof e.pii !== 'boolean') errors.push(`catalog: ${name}.pii must be true or false`);
  for (const [prop, type] of Object.entries(e.props ?? {})) {
    if (!TYPES.has(type)) errors.push(`catalog: ${name}.${prop} has type "${type}"`);
  }
}
for (const j of journeys) {
  if (!j.name || j.steps.length < 2) errors.push(`journeys: "${j.name}" needs a name and 2+ steps`);
  for (const s of j.steps) {
    if (!events[s.event])
      errors.push(`journeys: ${j.name} step "${s.event}" is not in config/events.json`);
  }
}

/** Top-level keys of an object literal starting at text[i] === '{' (shorthand and `key:`). */
function objectKeys(text, i) {
  let depth = 0;
  let body = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if ('{(['.includes(c)) depth++;
    if ('})]'.includes(c)) depth--;
    if (depth === 1 && c !== '{') body += c;
    else if (depth > 1) body += ' ';
    if (depth === 0) break;
  }
  return body
    .split(',')
    .map((part) => part.trim().match(/^(['"]?)([A-Za-z_$][\w$]*)\1\s*(?::|$)/)?.[2])
    .filter(Boolean);
}

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
  );
for (const file of files(join(root, 'apps/web/src'))) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(root.length);
  for (const m of text.matchAll(/(?<![.\w])track\(\s*/g)) {
    const at = m.index + m[0].length;
    const line = text.slice(0, at).split('\n').length;
    const lineText = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).trim();
    if (lineText.startsWith('//') || lineText.startsWith('*')) continue; // comments
    const name = text.slice(at).match(/^(['"])([^'"]+)\1/)?.[2];
    if (text.slice(m.index - 9, m.index) === 'function ') continue; // the definition itself
    if (!name) {
      errors.push(`${rel}:${line}: track() needs a literal event name`);
      continue;
    }
    if (!events[name]) {
      errors.push(`${rel}:${line}: event "${name}" is not in config/events.json`);
      continue;
    }
    used.add(name);
    const rest = text.slice(at + name.length + 2).trimStart();
    if (rest.startsWith(',')) {
      const brace = text.indexOf('{', at + name.length + 2);
      const between = text.slice(at + name.length + 2, brace).replace(/[\s,]/g, '');
      if (brace < 0 || between) {
        errors.push(`${rel}:${line}: "${name}" props must be an object literal`);
        continue;
      }
      for (const key of objectKeys(text, brace)) {
        if (!(key in (events[name].props ?? {}))) {
          errors.push(`${rel}:${line}: "${name}" has undeclared prop "${key}"`);
        }
      }
    }
  }
}

// Outbound webhook events (docs/public-api.md): every publishEvent() call names a catalogued type
// (TypeScript checks that too) and every catalogued type is published somewhere, because the
// catalog is what customers subscribe to.
const webhooks = JSON.parse(readFileSync(join(root, 'config/webhook-events.json'), 'utf8')).events;
const published = new Set();
for (const [type, e] of Object.entries(webhooks)) {
  if (!/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/.test(type)) errors.push(`webhooks: bad type "${type}"`);
  if (typeof e.description !== 'string' || !e.description)
    errors.push(`webhooks: ${type} lacks a description`);
}
for (const file of files(join(root, 'apps/api/src'))) {
  const text = readFileSync(file, 'utf8');
  // Calls look like publishEvent(req, tx, 'type', data); the definition and prose do not match.
  for (const m of text.matchAll(/(?<![.\w])publishEvent\(\s*\w+\s*,\s*\w+\s*,\s*/g)) {
    const at = m.index + m[0].length;
    const line = text.slice(0, at).split('\n').length;
    const type = text.slice(at).match(/^(['"])([^'"]+)\1/)?.[2];
    const rel = file.slice(root.length);
    if (!type) errors.push(`${rel}:${line}: publishEvent() needs a literal event type`);
    else if (!webhooks[type])
      errors.push(`${rel}:${line}: "${type}" is not in config/webhook-events.json`);
    else published.add(type);
  }
}
for (const type of Object.keys(webhooks)) {
  if (!published.has(type)) errors.push(`webhooks: ${type} is catalogued but never published`);
}

const unused = Object.keys(events).filter((n) => !used.has(n));
if (unused.length) console.warn(`events declared but never tracked: ${unused.join(', ')}`);
if (errors.length) {
  console.error(`check:events failed:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `check:events: ${used.size} events tracked, ${Object.keys(events).length} catalogued, ${journeys.length} journeys, ${published.size} webhook events`,
);
