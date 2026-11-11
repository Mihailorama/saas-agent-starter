// Legal baseline (docs/legal.md): legal links on sign-up and in the app, acceptance with age
// self-attestation at sign-up, marketing consent in settings, unsubscribe page, billing terms.
import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import config from '../../../config/legal.json' with { type: 'json' };
import { acceptTerms, signIn } from './mail';

test.describe.configure({ timeout: 90_000 });

const site = (process.env.VITE_SITE_URL || 'http://localhost:4321').replace(/\/+$/, '');
const ids = ['privacy', 'terms', 'refunds', 'cookies', 'imprint'] as const;

async function expectLegalLinks(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Legal' });
  for (const id of ids) {
    await expect(nav.getByRole('link', { name: config.documents[id].title })).toHaveAttribute(
      'href',
      `${site}/legal/${id}/`,
    );
  }
}

/** The token apps/api/src/legal.ts puts in unsubscribe links (same secret through .env). */
const unsubscribeToken = (userId: string) => {
  const key = Buffer.from(
    hkdfSync('sha256', process.env.BETTER_AUTH_SECRET!, '', 'unsubscribe-link-v1', 32),
  );
  return `${userId}.${createHmac('sha256', key).update(userId).digest('base64url')}`;
};

test('sign-up links the legal pages and asks for acceptance and age before anything else', async ({
  page,
}) => {
  await page.goto('/sign-in');
  await expectLegalLinks(page);
  await expect(page.getByRole('link', { name: 'Terms of service' }).first()).toBeVisible();

  await signIn(page, `${randomUUID()}@example.com`);
  await expect(page).toHaveURL(/\/accept-terms/);
  await expect(page.getByRole('heading', { name: 'Before you continue' })).toBeVisible();
  // The app is closed until then (except Settings, Privacy): going there comes back here.
  await page.goto('/settings/billing');
  await expect(page.getByRole('heading', { name: 'Before you continue' })).toBeVisible();

  const accept = page.getByRole('button', { name: 'Accept and continue' });
  const marketing = page.getByRole('checkbox', { name: /product news/ });
  await expect(accept).toBeDisabled();
  await expect(marketing).not.toBeChecked(); // opt-in, never pre-ticked
  await page.getByRole('checkbox', { name: /I agree to the Terms of service/ }).check();
  await expect(accept).toBeDisabled(); // the age confirmation is required too
  await page
    .getByRole('checkbox', { name: `I am at least ${config.age.minimum} years old.` })
    .check();
  await accept.click();
  // Back where the user was going: billing (no organization yet: create one).
  await page.getByLabel('Organization name').fill('Analytical Engines');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
  await page.goto('/settings/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible();
  await expectLegalLinks(page); // the app's footer

  // Marketing consent: off after sign-up, switched on and off in settings.
  const news = page.getByRole('switch', { name: 'Product news by email' });
  await expect(news).not.toBeChecked();
  await news.click();
  await expect(page.getByText('You will get product news.')).toBeVisible();
  await expect(news).toBeChecked();

  // The unsubscribe link of a marketing mail turns it off, without signing in.
  const session = await (await page.request.get('/api/auth/get-session')).json();
  const anonymous = await (await page.context().browser()!.newContext()).newPage();
  await anonymous.goto(
    `/unsubscribe?token=${encodeURIComponent(unsubscribeToken(session.user.id))}`,
  );
  await anonymous.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(anonymous.getByRole('heading', { name: 'You are unsubscribed' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Product news by email' })).not.toBeChecked();

  // No hidden fees: the billing page states taxes, renewal and how to cancel next to the prices.
  await page.goto('/settings/billing');
  await expect(page.getByText(config.billing.taxNote, { exact: false })).toBeVisible();
  await expect(page.getByText('renew automatically', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Refund and cancellation policy' }),
  ).toHaveAttribute('href', `${site}/legal/refunds/`);
});

test('an invalid unsubscribe link says so and points to the settings', async ({ page }) => {
  await page.goto('/unsubscribe?token=nope.nope');
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('This unsubscribe link is not valid.');
  await expect(alert.getByRole('link', { name: 'Settings, Privacy' })).toHaveAttribute(
    'href',
    '/settings/privacy',
  );
});

test('someone who does not accept can still download or delete their data', async ({ page }) => {
  await signIn(page, `${randomUUID()}@example.com`);
  await expect(page.getByRole('heading', { name: 'Before you continue' })).toBeVisible();
  await page.getByRole('link', { name: 'Download or delete your data' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download my data' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Delete your account/ })).toBeVisible();
  // Everything else still asks first.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Before you continue' })).toBeVisible();
});

test('a terms version published while a tab is open sends it to the acceptance step', async ({
  page,
}) => {
  await signIn(page, `${randomUUID()}@example.com`);
  await acceptTerms(page);
  await page.getByLabel('Organization name').fill('Analytical Engines');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText('No projects yet')).toBeVisible();

  // The API now refuses (a new version in config/legal.json), the tab still has its old answer.
  const refused = { error: 'legal acceptance required' };
  await page.route('**/api/projects**', (r) => r.fulfill({ status: 403, json: refused }));
  await page.route('**/api/legal/', async (r) => {
    const live = await (await r.fetch()).json();
    await r.fulfill({ json: { ...live, required: true, firstTime: false } });
  });
  // Client-side navigation: the route guard reuses its cached answer, the API call gets the 403.
  await page.getByRole('link', { name: 'Billing' }).click();
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
  await page.getByRole('link', { name: 'Projects' }).first().click();
  await expect(page).toHaveURL(/\/accept-terms/);
  await expect(page.getByRole('heading', { name: 'We updated our terms' })).toBeVisible();
});

test('the cookie policy lists every first-party cookie the app sets', async ({ page }) => {
  await signIn(page, `${randomUUID()}@example.com`);
  await acceptTerms(page);
  await expect(page.getByLabel('Organization name')).toBeVisible();
  const listed = config.processors
    .filter((p) => p.category === 'necessary')
    .flatMap((p) => (p.cookies ?? []).map((c) => c.name));
  const set = (await page.context().cookies()).map((c) => c.name.replace(/^__Secure-/, ''));
  expect(set).toContain('better-auth.session_token');
  expect(set.filter((n) => !listed.includes(n))).toEqual([]);
  // The session lasts as long as the policy says (config/legal.json sessionDays).
  const session = (await page.context().cookies()).find((c) => c.name.endsWith('session_token'))!;
  const days = (session.expires * 1000 - Date.now()) / 86_400_000;
  expect(Math.round(days)).toBe(config.sessionDays);
});
