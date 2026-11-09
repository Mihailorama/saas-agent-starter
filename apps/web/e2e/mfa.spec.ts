// 2FA and passkeys through the UI (ADR 0017). Passkeys use Chrome's CDP virtual authenticator.
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { signIn } from './mail';

// Many steps against a dev server that compiles on first use: the 30s default is too tight.
test.describe.configure({ timeout: 90_000 });

/** A new account named `grace-<id>` (code sign-up names it after the address) with an org. */
async function signUpWithOrg(page: Page) {
  const name = `grace-${randomUUID().slice(0, 8)}`;
  const email = `${name}@example.com`;
  await signIn(page, email);
  await page.getByLabel('Organization name').fill('Compilers');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  return { email, name };
}

async function openSecurity(page: Page, name: string) {
  await page.getByRole('button', { name }).first().click();
  await page.getByRole('menuitem', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
}

async function signOut(page: Page, name: string) {
  await page.getByRole('button', { name }).first().click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/sign-in/);
}

test('set up TOTP, then sign in with a code', async ({ page }) => {
  const { email, name } = await signUpWithOrg(page);
  await openSecurity(page, name);

  await page.getByRole('button', { name: 'Set up two-factor' }).click();
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

  // The email code is the first step; with TOTP on, the authenticator code follows.
  await signOut(page, name);
  await signIn(page, email);
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

  const { name } = await signUpWithOrg(page);
  await openSecurity(page, name);
  await page.getByLabel('Name (optional)').fill('Test laptop');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  const list = page.getByRole('list', { name: 'Your passkeys' });
  await expect(list.getByText('Test laptop')).toBeVisible();

  await page.getByRole('button', { name: 'Rename Test laptop' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Work laptop');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(list.getByText('Work laptop')).toBeVisible();

  // Discoverable credential: no email needed.
  await signOut(page, name);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  await openSecurity(page, name);
  await page.getByRole('button', { name: 'Delete Work laptop' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No passkeys yet.')).toBeVisible();
});
