import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  exampleValues,
  inUse,
  legalDocs,
  pricingModels,
  withOverride,
} from '../apps/site/src/legal.ts';
import { billingTerms } from '../apps/web/src/lib/billing-terms.ts';
import {
  buildArgErrors,
  configErrors,
  coverageErrors,
  lockErrors,
  webErrors,
} from './check-legal.mjs';

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
  const placeholder = {
    ...config,
    template: false,
    company: { ...config.company, vatId: 'XX000000000' },
  };
  assert.ok(configErrors(placeholder, components).includes('company.vatId: still a placeholder'));
  // A component without a processor must say it has none.
  const uncovered = [...components, { id: 'newthing', tier: 'optional' }];
  assert.match(configErrors(config, uncovered).join(), /component newthing: add a processor/);
  assert.deepEqual(configErrors(config, [...components, { id: 'newthing', processor: false }]), []);
});

test('every place that builds the site or the web passes every browser tool', () => {
  const all = config.processors.flatMap((p) => p.env ?? []).join(' ');
  assert.deepEqual(buildArgErrors(config, { a: all }), []);
  assert.match(
    buildArgErrors(config, { 'pages.yml': all.replace('VITE_GA4_ID', '') }).join(),
    /pages.yml: does not pass VITE_GA4_ID/,
  );
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
  // A broken extraction is an error, never "nothing to check".
  assert.equal(
    coverageErrors(config, { viteKeys: [], clearedCookies: [], privacyTools: [] }).length,
    3,
  );
});

test('a browser tool is in use with its env; a server tool with its component', () => {
  assert.equal(inUse(posthog, components, {}), false);
  assert.equal(inUse(posthog, components, { VITE_POSTHOG_KEY: 'phc_x' }), true);
  // Server-side use counts too: the worker's PostHog events with analytics connected.
  const connected = { components: { analytics: { mode: 'connect' } } };
  assert.equal(inUse(posthog, components, {}, connected), true);
  const umami = config.processors.find((p) => p.id === 'umami');
  assert.equal(inUse(umami, components, {}, connected), false);
  const ga4 = config.processors.find((p) => p.id === 'ga4');
  assert.equal(inUse(ga4, components, {}, connected), false); // browser only
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

test('the billing page states only the terms that apply to this organization', () => {
  const free = {
    provider: 'stripe',
    planId: 'free',
    status: null,
    canManage: true,
    selfService: { portal: true, cancel: true },
    plans: [
      { id: 'free', models: [], checkout: false },
      { id: 'pro', models: ['flat'], checkout: true },
    ],
  };
  const tax = 'TAX';
  assert.deepEqual(billingTerms(free, tax), [
    tax,
    'Paid plans renew automatically at the end of each billing period until cancelled.',
    'After you subscribe, you can cancel any time on this page.',
  ]);
  const member = { ...free, planId: 'pro', status: 'active', canManage: false };
  assert.match(billingTerms(member, tax).join(), /An organization admin can cancel/);
  const contract = { ...free, provider: 'manual', planId: 'pro', status: 'active' };
  const terms = billingTerms(contract, tax).join();
  assert.match(terms, /follows your contract/);
  assert.doesNotMatch(terms, /TAX|renew automatically|Cancel any time/);
});

test('a build-time override names processors by id and keeps the rest of the catalog', () => {
  const base = JSON.parse(readFileSync(new URL('../config/legal.json', import.meta.url), 'utf8'));
  const o = withOverride(
    base,
    JSON.stringify({ template: false, processors: [{ id: 'hosting', name: 'Real Host Inc.' }] }),
  );
  assert.equal(o.processors.length, base.processors.length);
  assert.equal(o.processors.find((p) => p.id === 'hosting').name, 'Real Host Inc.');
  assert.equal(
    o.processors.find((p) => p.id === 'hosting').purpose,
    base.processors.find((p) => p.id === 'hosting').purpose,
  );
  assert.equal(withOverride(base, undefined), base);
});

test('with the template off, example values in what a page shows are refused', () => {
  const base = JSON.parse(readFileSync(new URL('../config/legal.json', import.meta.url), 'utf8'));
  const hosting = base.processors.filter((p) => p.id === 'hosting');
  assert.deepEqual(exampleValues({ ...base, template: true }, hosting), []);
  const off = withOverride(base, JSON.stringify({ template: false }));
  const left = exampleValues(off, hosting);
  assert.ok(left.includes('processors.hosting.name'), left.join());
  assert.ok(
    left.some((k) => k.startsWith('company.')),
    left.join(),
  );
});

test('with providers agreed per contract, the policy names none and needs none', () => {
  const base = JSON.parse(readFileSync(new URL('../config/legal.json', import.meta.url), 'utf8'));
  const plans = JSON.parse(readFileSync(new URL('../config/plans.json', import.meta.url), 'utf8'));
  const off = withOverride(base, JSON.stringify({ template: false, processorsByContract: true }));
  const hosting = base.processors.filter((p) => p.id === 'hosting');
  assert.ok(!exampleValues(off, hosting).some((k) => k.startsWith('processors.')));
  const { privacy } = legalDocs(off, hosting, plans);
  const who = privacy.sections.find((s) => s.heading === 'Who processes your data');
  assert.equal(who.table.rows.length, 0);
  assert.match(who.paragraphs[0], /contract with us and its data processing agreement/);
});
