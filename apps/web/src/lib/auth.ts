import { passkeyClient } from '@better-auth/passkey/client';
import {
  adminClient,
  emailOTPClient,
  organizationClient,
  twoFactorClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Talks to the API's /api/auth/* on the same origin (Vite proxy in dev, nginx in Docker).
 * adminClient only types `user.role` and `session.impersonatedBy` (docs/admin.md): the admin
 * plugin's endpoints are closed; operator actions go through /api/admin. */
export const authClient = createAuthClient({
  plugins: [emailOTPClient(), organizationClient(), twoFactorClient(), passkeyClient(), adminClient()],
});
