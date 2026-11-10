import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inUse, legalDocs, pricingModels } from '../apps/site/src/legal.ts';
import { configErrors, coverageErrors, lockErrors, webErrors } from './check-legal.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const config = json('config/legal.json');
const { components } = json('config/components.json');
const plans = json('config/plans.json');
const posthog = config.processors.find((p) => p.id === 'posthog');
const twenty = config.processors.find((p) => p.id === 'twenty');

test('the committed config is complete; example values only while it is a template', () => {
  assert.deepEqual(configErrors(config, components), []);
  const real = configErrors({ ...config, template: false }, components);
  assert.ok(real.some((e) => e.startsWith('company.email: still an example value')));
  const broken = { ...config, processors: [{ ...posthog, component: 'nope' }] };
  assert.match(configErrors(broken, components).join(), /component nope/);
});

test('a tool the web reads from env, a cleared cookie or a data-map tool must be catalogued', () => {
  const ok = {
    viteKeys: ['VITE_POSTHOG_KEY', 'VITE_RELEASE'],
    clearedCookies: ['ph_'],
    privacyTools: ['PostHog', 'GA4'],
  };
  assert.deepEqual(coverageErrors(config, ok), []);
  const errors = coverageErrors(config, {
    viteKeys: ['VITE_HOTJAR_ID'],
    clearedCookies: ['_hj'],
    privacyTools: ['Hotjar'],
  });
  assert.equal(errors.length, 3);
});

test('a browser tool is in use with its env; a server tool with its component', () => {
  assert.equal(inUse(posthog, components, {}), false);
  assert.equal(inUse(posthog, components, { VITE_POSTHOG_KEY: 'phc_x' }), true);
  assert.equal(inUse(twenty, components, {}), false); // optional, no answers file
  assert.equal(inUse(twenty, components, {}, { components: { crm: { mode: 'connect' } } }), true);
  assert.equal(inUse(twenty, components, {}, { components: { crm: { mode: 'skip' } } }), false);
  const app = config.processors.find((p) => p.id === 'app');
  assert.equal(inUse(app, components, {}), true); // core
});

test('refund terms follow the pricing models; the cookie policy lists only tools in use', () => {
  assert.ok(pricingModels(plans).has('flat'));
  const contract = {
    plans: { x: { prices: { USD: [{ model: 'contract', provider: 'manual' }] } } },
  };
  const docs = legalDocs(config, [posthog], contract);
  assert.deepEqual(
    docs.refunds.sections.map((s) => s.heading).filter((h) => h !== 'Template'),
    ['Contracts', 'Consumers’ right of withdrawal', 'How to ask for a refund'],
  );
  assert.match(JSON.stringify(docs.cookies), /PostHog/);
  assert.doesNotMatch(JSON.stringify(legalDocs(config, [], plans).cookies), /PostHog/);
});

test('a text change under an accepted version fails; a new version asks for its lock line', () => {
  const docs = legalDocs(config, [], plans);
  const lock = Object.fromEntries(
    lockErrors(docs, {}).map((e) => {
      const [, id, entry] = e.match(/"(\w+)": (\{.*\})$/);
      return [id, JSON.parse(entry)];
    }),
  );
  assert.deepEqual(lockErrors(docs, lock), []);
  const changed = { ...config, governingLaw: 'the laws of Elsewhere' };
  assert.match(lockErrors(legalDocs(changed, [], plans), lock).join(), /terms: the text changed/);
});

test('the web footers and sign-up must link the legal pages', () => {
  const files = {
    'lib/legal.ts': "['privacy', 'terms', 'refunds', 'cookies', 'imprint']",
    'pages/sign-in.tsx': "<LegalLinks /> legalUrl('terms') legalUrl('privacy')",
    'pages/shell.tsx': '<LegalLinks align="start" />',
  };
  assert.deepEqual(webErrors(files), []);
  assert.equal(webErrors({ ...files, 'pages/shell.tsx': '' }).length, 1);
});
