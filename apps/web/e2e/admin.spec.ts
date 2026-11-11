// Operator console (docs/admin.md): an operator finds an organization, views the app as one of
// its members (banner, read-only), stops, and suspends the organization.
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { acceptTerms, signIn } from './mail';

test.describe.configure({ timeout: 120_000 });

/** Signs up (named after the address's local part) and creates an organization. */
async function signUp(page: Page, email: string, org: string) {
  await signIn(page, email);
  await acceptTerms(page);
  await page.getByLabel('Organization name').fill(org);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
}

test('view as user is read-only with a banner; suspend shows members a notice', async ({
  browser,
}) => {
  const customer = await (await browser.newContext()).newPage();
  const org = `Engines ${randomUUID().slice(0, 8)}`;
  const ada = `ada-${randomUUID().slice(0, 8)}`;
  await signUp(customer, `${ada}@example.com`, org);

  const page = await (await browser.newContext()).newPage();
  await signUp(page, process.env.E2E_OPERATOR_EMAIL!, 'Support');
  // Operators need TOTP.
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent()) ?? '';
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  await page.getByLabel('Code from the app').fill(totp.generate());
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.goto('/admin');
  await page.getByLabel('Search').fill(org);
  await page.getByRole('link', { name: org }).click();
  await expect(page.getByRole('heading', { name: org })).toBeVisible();

  await page.getByRole('button', { name: 'View as' }).click();
  await page.getByLabel('Reason (kept in the audit log)').fill('E2E: checking the projects page');
  await page.getByRole('button', { name: 'View as user' }).click();
  const banner = page.getByRole('status').filter({ hasText: `Viewing as ${ada}` });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByLabel('Name').fill('Should not exist');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('read-only while viewing as a user')).toBeVisible();
  await page.keyboard.press('Escape');
  // The banner stays on every page.
  await page.getByRole('link', { name: 'Billing' }).click();
  await expect(banner).toBeVisible();

  await banner.getByRole('button', { name: 'Stop viewing' }).click();
  await expect(page.getByRole('heading', { name: ada })).toBeVisible();
  await expect(page.getByText('operator.impersonation.started')).toBeVisible();

  await page.getByRole('link', { name: org }).click();
  await page.getByRole('button', { name: 'Suspend' }).click();
  await page.getByLabel('Reason (kept in the audit log)').fill('E2E: suspension check');
  await page.getByRole('button', { name: 'Suspend' }).last().click();
  await expect(page.getByText(/Suspended since/)).toBeVisible();

  await customer.reload();
  await expect(customer.getByText('This organization is suspended')).toBeVisible();
});
