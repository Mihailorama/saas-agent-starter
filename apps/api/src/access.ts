import { apiKey } from '@better-auth/api-key';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements as adminStatements } from 'better-auth/plugins/admin/access';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';

/**
 * Organization roles = Better Auth defaults plus `apiKey` (used by @better-auth/api-key for
 * organization-owned keys): owners and admins manage keys, members do not.
 */
const keyAdmin = { apiKey: ['create', 'read', 'update', 'delete'] } as const;
const ac = createAccessControl({ ...defaultStatements, ...keyAdmin });
export const orgAccess = {
  ac,
  roles: {
    owner: ac.newRole({ ...ownerAc.statements, ...keyAdmin }),
    admin: ac.newRole({ ...adminAc.statements, ...keyAdmin }),
    member: ac.newRole(memberAc.statements),
  },
};

/**
 * Customer API keys, owned by the organization (docs/public-api.md). Only a SHA-256 of the key is
 * stored. Rate limiting is ours (Redis, per key, app.ts), not the plugin's per-row counter.
 * Keys are created/revoked through /api/api-keys only (scopes, audit log); app.ts blocks the
 * plugin's own /api/auth/api-key/* HTTP endpoints.
 */
export const apiKeys = apiKey({
  references: 'organization',
  defaultPrefix: 'sk_',
  startingCharactersConfig: { charactersLength: 10 },
  keyExpiration: { defaultExpiresIn: null, minExpiresIn: 1, maxExpiresIn: 365 },
  rateLimit: { enabled: false },
  permissions: { defaultPermissions: {} },
});

/**
 * Better Auth admin plugin roles (docs/admin.md): `user` for everyone, `operator` for the back
 * office. Separate from organization roles: an operator is no member of customer orgs. The plugin
 * checks these only for impersonation (its HTTP endpoints are closed; app.ts); everything else
 * operators do goes through /api/admin (requireOperator, reason, audit_log).
 */
const platformAc = createAccessControl({ ...adminStatements });
export const operatorAccess = {
  ac: platformAc,
  roles: {
    user: platformAc.newRole({ user: [], session: [] }),
    operator: platformAc.newRole({
      user: ['list', 'get', 'impersonate'],
      session: ['list', 'revoke'],
    }),
  },
};
