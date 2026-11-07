import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('sign up, create an organization and a project', async ({ page }) => {
  // On-prem default: no request leaves our own hosts (analytics sinks are env-gated).
  const hosts = new Set<string>();
  page.on('request', (req) => hosts.add(new URL(req.url()).hostname));
  await page.goto('/');
  await expect(page).toHaveURL(/sign-in/);

  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Email').fill(`${randomUUID()}@example.com`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByLabel('Organization name').fill('Analytical Engines');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
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

  // No third-party sink configured in tests: nothing to consent to, no foreign hosts.
  await expect(page.getByRole('region', { name: 'Analytics consent' })).toHaveCount(0);
  expect([...hosts]).toEqual(['localhost']);
});

test('AI transparency page is public', async ({ page }) => {
  await page.goto('/ai-transparency');
  await expect(page.getByRole('heading', { name: 'How we use AI' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project summaries' })).toBeVisible();
  await expect(page.getByText('claude-haiku-5-5', { exact: false })).toBeVisible();
});

test('org admin creates an API key and a webhook endpoint', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Grace Hopper');
  await page.getByLabel('Email').fill(`${randomUUID()}@example.com`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
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
