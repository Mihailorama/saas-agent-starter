// node --test 'scripts/*.test.mjs'. The landing's "What is in the box" (apps/site/src/stack.ts)
// against docs/LICENSES.md: every image there is shown (or listed as not shown) with its license.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { notShown, stack } from '../apps/site/src/stack.ts';

/** `image` -> license from the first table of docs/LICENSES.md. */
export function licenseTable(md) {
  const rows = new Map();
  const table = md.split('\n## ')[0];
  for (const line of table.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const image = cells[1]?.match(/^`([^`]+)`/)?.[1];
    if (image && cells.length >= 4) rows.set(image, cells[3]);
  }
  return rows;
}

// simple-icons is the site's dependency, not the root's.
const icons = await import(
  new URL('../apps/site/node_modules/simple-icons/index.mjs', import.meta.url).href
);
const table = licenseTable(readFileSync(new URL('../docs/LICENSES.md', import.meta.url), 'utf8'));
const tools = stack.flatMap((g) => g.tools);

test('the license table parses', () => {
  assert.ok(table.size > 30, `only ${table.size} images`);
  assert.equal(table.get('temporalio/server'), 'MIT');
});

test('every image in docs/LICENSES.md is on the landing or deliberately not shown', () => {
  const shown = new Set(tools.flatMap((t) => t.images));
  const missing = [...table.keys()].filter((i) => !shown.has(i) && !notShown.includes(i));
  assert.deepEqual(missing, [], 'add them to apps/site/src/stack.ts');
});

test('each tool shows the license docs/LICENSES.md gives its images', () => {
  for (const t of tools)
    for (const i of t.images) assert.equal(table.get(i), t.license, `${t.name} (${i})`);
});

test('every icon slug exists in Simple Icons', () => {
  const slugs = new Set(Object.values(icons).map((i) => i.slug));
  for (const t of tools.filter((t) => t.icon)) assert.ok(slugs.has(t.icon), t.icon);
});
