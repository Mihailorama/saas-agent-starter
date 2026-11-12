// node --test 'scripts/*.test.mjs'. Pure parts of ui-council.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  blind,
  memberCommand,
  memberPasses,
  pairedShots,
  parseAnswer,
  pickShots,
  prompt,
  referenceShots,
} from './ui-council.mjs';

const cats = ['typography', 'consistency'];
const config = { target: 9, categories: cats, projects: ['desktop-light'], screens: ['screen-*'] };

test('pickShots keeps configured projects and screens only', () => {
  const d = mkdtempSync(join(tmpdir(), 'council-'));
  for (const p of ['desktop-light', 'mobile-dark']) {
    mkdirSync(join(d, p));
    for (const f of ['screen-list.png', 'gallery-button.png']) writeFileSync(join(d, p, f), '');
  }
  assert.deepEqual(
    pickShots(d, config).map((s) => `${s.project}/${s.id}`),
    ['desktop-light/screen-list'],
  );
});

test('referenceShots finds one product per folder with PNGs', () => {
  const d = mkdtempSync(join(tmpdir(), 'refs-'));
  mkdirSync(join(d, 'linear'));
  writeFileSync(join(d, 'linear', 'inbox.png'), '');
  mkdirSync(join(d, 'empty'));
  assert.deepEqual(Object.keys(referenceShots(d)), ['linear']);
});

test('blind gives neutral labels and does not keep the input order', () => {
  const labels = blind(['this branch', 'main', 'linear'], () => 0);
  assert.deepEqual(Object.keys(labels), ['product-1', 'product-2', 'product-3']);
  assert.notEqual(labels['product-1'], 'this branch');
  assert.deepEqual(Object.values(labels).sort(), ['linear', 'main', 'this branch']);
});

test('the prompt never names the target, the branch or main', () => {
  const text = prompt({
    labels: { 'product-1': 'main', 'product-2': 'this branch' },
    images: [
      {
        label: 'product-1',
        project: 'desktop-light',
        id: 'screen-list',
        file: '/x/product-1/a.png',
      },
    ],
    categories: cats,
    ours: 'product-2',
  });
  assert.doesNotMatch(text, /\b9\.?0?\b|target|this branch|\bmain\b|before|after/i);
});

test('parseAnswer maps labels back and rejects missing or out-of-range scores', () => {
  const labels = { 'product-1': 'main', 'product-2': 'this branch' };
  const answer = `ok {"scores": {"product-1": {"typography": 7, "consistency": 7.5}, "product-2": {"typography": 9.1, "consistency": 9}}, "findings": [{"screen": "screen-list", "issue": "a", "fix": "b"}]}`;
  const r = parseAnswer(answer, labels, cats);
  assert.equal(r.scores['this branch'].typography, 9.1);
  assert.equal(r.findings.length, 1);
  assert.throws(() => parseAnswer('{"scores": {"product-1": {}}}', labels, cats));
  assert.throws(() => parseAnswer(answer.replace('9.1', '11'), labels, cats));
  assert.throws(() => parseAnswer('no json', labels, cats));
});

test('a member passes only with every category at the target and no better reference', () => {
  const ours = { typography: 9, consistency: 9.5 };
  assert.equal(
    memberPasses({ 'this branch': ours, main: { typography: 10, consistency: 10 } }, 9),
    true,
  );
  assert.equal(memberPasses({ 'this branch': { ...ours, typography: 8.9 } }, 9), false);
  assert.equal(
    memberPasses({ 'this branch': ours, linear: { typography: 9.5, consistency: 9.5 } }, 9),
    false,
  );
});

test('member commands are read-only, carry the model and drop API keys', () => {
  process.env.OPENAI_API_KEY = 'local-dev-x';
  process.env.ANTHROPIC_API_KEY = 'local-dev-x';
  const img = [{ file: '/x/a.png' }];
  const codex = memberCommand(
    { name: 'c', cli: 'codex', model: 'm1', effort: 'high' },
    'p',
    img,
    '/x',
  );
  assert.deepEqual(codex.args.slice(0, 3), ['exec', '-m', 'm1']);
  assert.ok(codex.args.includes('read-only') && codex.args.includes('/x/a.png'));
  assert.equal(codex.env.OPENAI_API_KEY, undefined);
  const claude = memberCommand({ name: 'o', cli: 'claude', model: 'm2' }, 'p', img, '/x');
  assert.ok(claude.args.includes('m2') && claude.args.includes('Read'));
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
  assert.throws(
    () => memberCommand({ name: 'n', cli: 'claude' }, 'p', img, '/x'),
    /model is required/,
  );
  assert.throws(
    () => memberCommand({ name: 'n', cli: 'x', model: 'm' }, 'p', img, '/x'),
    /unknown cli/,
  );
});

test('pairedShots keeps only the screens both sides have', () => {
  const s = (project, id) => ({ project, id, path: `/${project}/${id}.png` });
  const ours = [s('desktop-light', 'screen-list'), s('mobile-light', 'screen-list')];
  const theirs = [s('desktop-light', 'screen-list'), s('desktop-dark', 'screen-list')];
  assert.deepEqual(pairedShots(theirs, ours), [theirs[0]]);
});
