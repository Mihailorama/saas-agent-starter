// node --test 'scripts/*.test.mjs'. The landing's "What is in the box" (apps/site/src/stack.ts)
// against docs/LICENSES.md: every image there is shown (or listed as not shown) with its license.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ownSkills, thirdPartySkills } from '../apps/site/src/skills.ts';
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

test('a connect-only tool says what you connect and claims no license of the box', () => {
  for (const t of tools.filter((t) => !t.images.length)) {
    assert.ok(t.connect, `${t.name}: connect-only needs connect`);
    assert.equal(t.license, undefined, t.name);
  }
});

test('every Claude Code command in the repository is listed as our skill, and only those', () => {
  const commands = readdirSync(new URL('../.claude/commands/', import.meta.url))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
  assert.deepEqual(ownSkills.map((s) => s.name).sort(), commands);
});

test('third-party skills carry an author and a license the gate allows for tooling', () => {
  for (const s of thirdPartySkills) {
    assert.ok(s.author && s.href.startsWith('https://github.com/'), s.name);
    // Non-commercial or copyleft skills cannot ship with a template people build businesses on.
    assert.match(s.license, /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC|MIT-0|CC0-1\.0)$/, s.name);
  }
});

test('every icon slug exists in Simple Icons', () => {
  const slugs = new Set(Object.values(icons).map((i) => i.slug));
  for (const t of tools.filter((t) => t.icon)) assert.ok(slugs.has(t.icon), t.icon);
});
