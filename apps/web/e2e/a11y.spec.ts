// Accessibility (axe-core, WCAG 2.2 A/AA): every page of the app and the dev UI gallery, in light
// and dark mode. Serious and critical violations fail the run (docs/ui.md).
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectAccessible, expectAccessibleInBothThemes } from './axe';
import { mailedLink } from './mail';

// Every page is scanned in two themes on a dev server: far beyond the 30s default.
test.describe.configure({ timeout: 240_000 });

const screens = ['list', 'detail', 'form', 'settings', 'empty', 'loading', 'error'];

test('UI gallery and reference screens', async ({ page }) => {
  await page.goto('/dev/ui');
  // The first visit compiles the lazily loaded gallery on the dev server.
  await expect(page.getByRole('heading', { name: 'UI gallery' })).toBeVisible({ timeout: 30_000 });
  await expectAccessibleInBothThemes(page, '/dev/ui');

  for (const screen of screens) {
    await page.goto(`/dev/ui/screens/${screen}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessibleInBothThemes(page, `/dev/ui/screens/${screen}`);
  }

  // Open states: the form after a failed submit, and the command palette.
  await page.goto('/dev/ui/screens/form');
  await page.getByRole('button', { name: 'Save project' }).click();
  await expect(page.getByText('Enter a name.')).toBeVisible();
  await expectAccessible(page, 'form with errors');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await expectAccessible(page, 'command palette');
});

test('public pages', async ({ page }) => {
  for (const path of ['/sign-in', '/ai-transparency', '/reset-password?error=INVALID_TOKEN']) {
    await page.goto(path);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expectAccessibleInBothThemes(page, path);
  }
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expectAccessible(page, '/sign-in (sign up)');
});

test('signed-in pages', async ({ page }) => {
  const email = `${randomUUID()}@example.com`;
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expectAccessible(page, 'check your email');
  await page.goto(await mailedLink(email, /Confirm/));

  await expect(page.getByLabel('Organization name')).toBeVisible();
  await expectAccessibleInBothThemes(page, 'create organization');
  await page.getByLabel('Organization name').fill('Analytical Engines');
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page.getByText('No projects yet')).toBeVisible();
  await expectAccessibleInBothThemes(page, '/ (empty)');
  await page.getByRole('button', { name: 'New project' }).first().click();
  await expectAccessible(page, 'new project dialog');
  await page.getByLabel('Name').fill('Difference Engine');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('link', { name: 'Difference Engine' })).toBeVisible();
  await expectAccessibleInBothThemes(page, '/ (list)');

  await page.getByRole('link', { name: 'Difference Engine' }).click();
  await expect(page.getByRole('heading', { name: 'Difference Engine' })).toBeVisible();
  await expectAccessibleInBothThemes(page, '/projects/$projectId');

  for (const [path, heading] of [
    ['/ai-calls', 'AI calls'],
    ['/settings/api-keys', 'API keys'],
    ['/settings/members', 'Members'],
    ['/settings/webhooks', 'Webhooks'],
    ['/settings/security', 'Security'],
    ['/settings/billing', 'Billing'],
    ['/settings/privacy', 'Privacy'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expectAccessibleInBothThemes(page, path);
  }
});
