// 2FA and passkeys through the UI (ADR 0017). Passkeys use Chrome's CDP virtual authenticator.
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { mailedLink } from './mail';

const password = 'correct-horse-battery';
// Many steps against a dev server that compiles on first use: the 30s default is too tight.
test.describe.configure({ timeout: 90_000 });

async function signUpWithOrg(page: Page) {
  const email = `${randomUUID()}@example.com`;
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Grace Hopper');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await mailedLink(email, /Confirm/));
  await page.getByLabel('Organization name').fill('Compilers');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  return email;
}

async function openSecurity(page: Page) {
  await page
    .getByRole('button', { name: /Grace Hopper/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
}

async function signOut(page: Page) {
  await page
    .getByRole('button', { name: /Grace Hopper/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/sign-in/);
}

test('set up TOTP, then sign in with a code', async ({ page }) => {
  const email = await signUpWithOrg(page);
  await openSecurity(page);

  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent()) ?? '';
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  await page.getByLabel('Code from the app').fill(totp.generate());
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('list', { name: 'Backup codes' }).getByRole('listitem')).toHaveCount(
    10,
  );
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  await signOut(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /invalid/i })).toBeVisible();
  // A code works once: use the next step's code, not the one just used for enrolment.
  await page
    .getByLabel('Authentication code')
    .fill(totp.generate({ timestamp: Date.now() + 30_000 }));
  await page.getByLabel('Trust this device for 30 days').check();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
});

test('add, rename, sign in with and delete a passkey', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await signUpWithOrg(page);
  await openSecurity(page);
  await page.getByLabel('Name (optional)').fill('Test laptop');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  const list = page.getByRole('list', { name: 'Your passkeys' });
  await expect(list.getByText('Test laptop')).toBeVisible();

  await page.getByRole('button', { name: 'Rename Test laptop' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Work laptop');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(list.getByText('Work laptop')).toBeVisible();

  // Discoverable credential: no email needed.
  await signOut(page);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  await openSecurity(page);
  await page.getByRole('button', { name: 'Delete Work laptop' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No passkeys yet.')).toBeVisible();
});
