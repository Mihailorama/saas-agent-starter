import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('sign up, create an organization and a project', async ({ page }) => {
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

  // The owner is an org admin and sees LLM Ops (empty: no AI configured in tests).
  await page.getByRole('link', { name: 'LLM Ops' }).click();
  await expect(page.getByRole('heading', { name: 'LLM Ops' })).toBeVisible();
  await expect(page.getByText('No prompt versions used in this period.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI calls' })).toBeVisible();
  await expect(page.getByText('No AI calls match these filters.')).toBeVisible();
});

test('AI transparency page is public', async ({ page }) => {
  await page.goto('/ai-transparency');
  await expect(page.getByRole('heading', { name: 'How we use AI' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project summaries' })).toBeVisible();
  await expect(page.getByText('claude-haiku-5-5', { exact: false })).toBeVisible();
});
