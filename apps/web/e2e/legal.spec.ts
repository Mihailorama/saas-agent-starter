// Legal baseline (docs/legal.md): legal links on sign-up and in the app, acceptance with age
// self-attestation at sign-up, marketing consent in settings, unsubscribe page, billing terms.
import { createHmac, randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import config from '../../../config/legal.json' with { type: 'json' };
import { signIn } from './mail';

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
const unsubscribeToken = (userId: string) =>
  `${userId}.${createHmac('sha256', process.env.BETTER_AUTH_SECRET!).update(`unsubscribe:${userId}`).digest('base64url')}`;

test('sign-up links the legal pages and asks for acceptance and age before anything else', async ({
  page,
}) => {
  await page.goto('/sign-in');
  await expectLegalLinks(page);
  await expect(page.getByRole('link', { name: 'Terms of service' }).first()).toBeVisible();

  await signIn(page, `${randomUUID()}@example.com`);
  await expect(page).toHaveURL(/\/accept-terms/);
  await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
  // The app is closed until then: going there comes back here.
  await page.goto('/settings/privacy');
  await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();

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
  // Back where the user was going: the privacy settings (no organization yet: create one).
  await page.getByLabel('Organization name').fill('Analytical Engines');
  await page.getByRole('button', { name: 'Create organization' }).click();
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

test('an invalid unsubscribe link says so', async ({ page }) => {
  await page.goto('/unsubscribe?token=nope.nope');
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page.getByRole('alert')).toHaveText('This unsubscribe link is not valid.');
});
