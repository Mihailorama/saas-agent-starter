// Staff single sign-on (docs/sso.md): a signed-out operator opens Grafana, is sent to the app's
// sign-in, signs in once (code, then two-factor) and lands in Grafana as Admin, no Grafana login.
import { expect, test } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { acceptTerms, signIn } from './mail';

const grafana = process.env.E2E_GRAFANA_URL;
test.skip(!grafana, 'needs Grafana started for SSO (docs/sso.md "Test it")');
test.describe.configure({ timeout: 120_000 });

test('an operator signs in to Grafana through the app', async ({ browser }) => {
  const email = process.env.E2E_SSO_OPERATOR_EMAIL!;
  // Tools need what the operator console needs: an operator with two-factor on.
  const setup = await (await browser.newContext()).newPage();
  await signIn(setup, email);
  await acceptTerms(setup);
  await setup.getByLabel('Organization name').fill('Ops');
  await setup.getByRole('button', { name: 'Create organization' }).click();
  await expect(setup.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await setup.goto('/settings/security');
  await setup.getByRole('button', { name: 'Set up two-factor' }).click();
  await setup.getByRole('button', { name: 'Continue' }).click();
  const secret = (await setup.getByTestId('totp-secret').textContent()) ?? '';
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  await setup.getByLabel('Code from the app').fill(totp.generate());
  await setup.getByRole('button', { name: 'Turn on' }).click();
  await setup.getByRole('button', { name: 'Done' }).click();

  // A fresh browser: Grafana sends it to the app, which asks for the sign-in.
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${grafana}/login`);
  await expect(page).toHaveURL(/\/sign-in\?.*client_id=grafana/);
  await signIn(page, email, { open: false });
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  // A new time step: the setup's code is spent (each TOTP code works once, mfa.ts).
  await page.waitForTimeout(((30 - (Math.floor(Date.now() / 1000) % 30)) % 30) * 1000 + 1000);
  await page.getByLabel('Authentication code').fill(totp.generate());
  await page.getByRole('button', { name: 'Verify' }).click();

  // Grafana's first sign-in also creates its user and keys: give it time.
  await expect(page).toHaveURL(new RegExp(`^${grafana}/(?!login)`), { timeout: 30_000 });
  const me = await page.request.get(`${grafana}/api/user`);
  expect(me.status()).toBe(200);
  expect((await me.json()).email).toBe(email);
  const orgs = await (await page.request.get(`${grafana}/api/user/orgs`)).json();
  expect(orgs[0].role).toBe('Admin');
});
