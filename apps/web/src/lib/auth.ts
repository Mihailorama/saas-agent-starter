import { passkeyClient } from '@better-auth/passkey/client';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Talks to the API's /api/auth/* on the same origin (Vite proxy in dev, nginx in Docker). */
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient(), passkeyClient()],
});

/** Where to go after sign-in: only same-app paths, never another origin (open redirect). */
export const safeRedirect = (to: unknown) =>
  typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to : '/';
