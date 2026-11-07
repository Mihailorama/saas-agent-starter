import { passkeyClient } from '@better-auth/passkey/client';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Talks to the API's /api/auth/* on the same origin (Vite proxy in dev, nginx in Docker). */
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient(), passkeyClient()],
});
