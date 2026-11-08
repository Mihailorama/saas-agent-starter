// Shared by the e2e specs.
// The worker delivers every mail to the compose Mailpit; read it like the user's inbox would.
import { expect, type Page } from '@playwright/test';

const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';
type Summary = { ID: string; Subject: string };
const inbox = async (to: string): Promise<Summary[]> =>
  (
    await (
      await fetch(`${mailpit}/api/v1/search?${new URLSearchParams({ query: `to:${to}` })}`)
    ).json()
  ).messages;

/** Text of the newest mail to `to` whose subject matches and whose id is not in `seen`. */
async function mailText(to: string, subject: RegExp, seen: string[] = []): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const hit = (await inbox(to)).find((m) => subject.test(m.Subject) && !seen.includes(m.ID));
    if (hit) return (await (await fetch(`${mailpit}/api/v1/message/${hit.ID}`)).json()).Text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail to ${to} in Mailpit: are Mailpit and the worker (pnpm worker) up?`);
}

/**
 * Asks for a sign-in code on the sign-in page; returns the mailed code without entering it.
 * Signs up on first use: the account is named after the address's local part.
 */
export async function requestCode(page: Page, email: string): Promise<string> {
  const seen = (await inbox(email)).map((m) => m.ID);
  // One client IP per sign-in (the API trusts x-forwarded-for in e2e, playwright.config.ts): the
  // per-IP auth limit then applies per simulated user, like in production.
  const ip = `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': ip });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  return (await mailText(email, /sign-in code/, seen)).match(/\b\d{6}\b/)![0];
}

/** Signs in (or up) with the mailed code; the 6th digit submits. */
export async function signIn(page: Page, email: string) {
  const code = await requestCode(page, email);
  await page.getByLabel('Code', { exact: true }).fill(code);
}
