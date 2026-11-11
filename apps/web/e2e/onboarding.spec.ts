// Onboarding (docs/onboarding.md) with the `onboarding` flag on: the build on
// PLAYWRIGHT_ONBOARDING_PORT (playwright.config.ts). The flag-off path is in smoke.spec.ts.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectAccessibleInBothThemes } from './axe';
import { acceptTerms, signIn } from './mail';

test('flag on: the tour starts once, can be dismissed and restarted; the checklist renders', async ({
  page,
}) => {
  test.slow(); // sign-up plus the first load of another dev server
  const name = `ada-${randomUUID().slice(0, 8)}`; // a code sign-up is named after the address
  await signIn(page, `${name}@example.com`);
  await acceptTerms(page);
  await page.getByLabel('Organization name').fill('Analytical Engines');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText('No projects yet')).toBeVisible();

  // Same session on the flag-on build: cookies are per host, not per port.
  await page.goto(`http://localhost:${process.env.PLAYWRIGHT_ONBOARDING_PORT ?? '5176'}/`);
  const step = page.getByRole('dialog', { name: 'Your organization' });
  await expect(step).toBeVisible({ timeout: 15_000 });
  await expectAccessibleInBothThemes(page, 'product tour');
  await page.keyboard.press('Escape');
  await expect(step).toHaveCount(0);

  const checklist = page.getByRole('list', { name: 'Setup steps' });
  await expect(checklist.getByRole('listitem')).toHaveCount(5);
  await expectAccessibleInBothThemes(page, 'onboarding checklist');

  // Seen: a reload does not start it again; the user menu does, and it runs to the end.
  await page.reload();
  await expect(checklist).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name }).first().click();
  await page.getByRole('menuitem', { name: 'Product tour' }).click();
  await expect(step).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /Next/ }).click();
  await expect(page.getByRole('dialog', { name: 'Your account' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A done item comes from the server: creating a project ticks it off.
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByLabel('Name').fill('Difference Engine');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('link', { name: 'Difference Engine' })).toBeVisible();
  await expect(checklist.getByRole('button', { name: 'New project' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Dismiss the setup checklist' }).click();
  await expect(checklist).toHaveCount(0);
});
