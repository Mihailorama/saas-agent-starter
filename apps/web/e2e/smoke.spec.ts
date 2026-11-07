import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { mailedLink } from './mail';

async function signUp(page: Page, email: string) {
  await page.goto('/');
  await expect(page).toHaveURL(/sign-in/);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  // The confirmation link signs the user in and lands on the app.
  await page.goto(await mailedLink(email, /Confirm/));
}

test('sign up, create an organization and a project', async ({ page }) => {
  // On-prem default: no request leaves our own hosts (analytics sinks are env-gated).
  const hosts = new Set<string>();
  page.on('request', (req) => hosts.add(new URL(req.url()).hostname));
  await signUp(page, `${randomUUID()}@example.com`);

  await page.getByLabel('Organization name').fill('Analytical Engines');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByText('No projects yet')).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByLabel('Name').fill('Difference Engine');
  await page.getByLabel('Description (optional)').fill('Tabulates polynomial functions.');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('link', { name: 'Difference Engine' })).toBeVisible();

  // The owner is an org admin and sees the AI call log (empty: no AI configured in tests).
  await page.getByRole('link', { name: 'AI calls' }).click();
  await expect(page.getByRole('heading', { name: 'AI calls' })).toBeVisible();
  await expect(page.getByText('No AI calls match these filters.')).toBeVisible();

  // Billing: plan, usage and prices read from config/plans.json through the API.
  await page.getByRole('link', { name: 'Billing' }).click();
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Projects' })).toHaveAttribute(
    'aria-valuenow',
    '1',
  );
  await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).toBeVisible();

  // Data-subject rights (docs/privacy.md): the owner sees both cards and can request an export.
  await page.goto('/settings/privacy');
  await expect(page.getByText('Your data', { exact: true })).toBeVisible();
  await expect(page.getByText('Organization data', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Download my data' }).click();
  await expect(page.getByText('Export started', { exact: false })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Requests' }).first()).toContainText('Export');

  // No third-party sink configured in tests: nothing to consent to, no foreign hosts.
  await expect(page.getByRole('region', { name: 'Analytics consent' })).toHaveCount(0);
  // No Chatwoot configured: no Help entry and no widget request (docs/support.md).
  await expect(page.getByRole('button', { name: 'Help' })).toHaveCount(0);
  expect([...hosts]).toEqual(['localhost']);
});

test('forgotten password: reset through the mailed link', async ({ page, context }) => {
  test.slow(); // two mailed links and five page loads on the Vite dev server
  const email = `${randomUUID()}@example.com`;
  await signUp(page, email);
  await expect(page.getByLabel('Organization name')).toBeVisible();
  await context.clearCookies();

  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await page.goto(await mailedLink(email, /Reset/));
  await expect(page).toHaveURL(/reset-password\?token=/);
  await page.getByLabel('New password', { exact: true }).fill('a-brand-new-passphrase');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/sign-in/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-brand-new-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Organization name')).toBeVisible();
});

test('AI transparency page is public', async ({ page }) => {
  await page.goto('/ai-transparency');
  await expect(page.getByRole('heading', { name: 'How we use AI' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project summaries' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Support request triage' })).toBeVisible();
  // One model list per purpose.
  await expect(page.getByText('claude-haiku-5-5', { exact: false })).toHaveCount(2);
});

test('org admin creates an API key and a webhook endpoint', async ({ page }) => {
  await signUp(page, `${randomUUID()}@example.com`);
  await page.getByLabel('Organization name').fill('Compilers');
  await page.getByRole('button', { name: 'Create organization' }).click();

  await page.getByRole('link', { name: 'API keys' }).click();
  await expect(page.getByText('No API keys yet')).toBeVisible();
  await page.getByRole('button', { name: 'New API key' }).click();
  await page.getByLabel('Name').fill('CI');
  await page.getByLabel('projects:read').check();
  await page.getByRole('button', { name: 'Create key' }).click();
  // Shown once, then only its prefix.
  await expect(page.getByRole('textbox', { name: 'Your new API key' })).toHaveValue(/^sk_/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: 'CI', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Webhooks' }).click();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByLabel('URL').fill('https://hooks.example.com/in');
  await page.getByLabel('project.created').check();
  await page.getByRole('button', { name: 'Add endpoint' }).last().click();
  await expect(page.getByRole('textbox', { name: 'Signing secret' })).toHaveValue(/^whsec_/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('https://hooks.example.com/in')).toBeVisible();
  await expect(page.getByText('No deliveries yet.')).toBeVisible();
});
