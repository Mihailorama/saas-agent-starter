import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// The worker delivers every mail to the compose Mailpit; read it like the user's inbox would.
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';
async function mailedLink(to: string, subject: RegExp): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const query = new URLSearchParams({ query: `to:${to}` });
    const { messages } = await (await fetch(`${mailpit}/api/v1/search?${query}`)).json();
    const hit = messages.find((m: { Subject: string }) => subject.test(m.Subject));
    if (hit) {
      const mail = await (await fetch(`${mailpit}/api/v1/message/${hit.ID}`)).json();
      const link = new URL(mail.Text.match(/https?:\/\/[^\s\]]+/)[0]);
      return link.pathname + link.search; // same app, whatever port the test server runs on
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail to ${to} in Mailpit: are Mailpit and the worker (pnpm worker) up?`);
}

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

  // No third-party sink configured in tests: nothing to consent to, no foreign hosts.
  await expect(page.locator('#cc-main')).toHaveCount(0);
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
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Organization name')).toBeVisible();
});

test('AI transparency page is public', async ({ page }) => {
  await page.goto('/ai-transparency');
  await expect(page.getByRole('heading', { name: 'How we use AI' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project summaries' })).toBeVisible();
  await expect(page.getByText('claude-haiku-5-5', { exact: false })).toBeVisible();
});
