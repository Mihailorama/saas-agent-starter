// Staff single sign-on (docs/sso.md): the app is the OpenID Connect provider for the web UIs of
// the bundled tools (Grafana, Temporal UI, Langfuse, ...). Only operators (OPERATOR_EMAILS) get
// tokens for these clients; they carry `groups: ["operators"]` for the tools' role mapping.
// A client exists when both SSO_<ID>_SECRET and SSO_<ID>_REDIRECT_URIS are set; the API writes
// it at start (syncSsoClients), so there is no client admin UI and nothing to click.
import { createHash } from 'node:crypto';
import { oauthClient } from '@app/db';
import { APIError } from 'better-auth/api';
import { inArray } from 'drizzle-orm';
import { db } from './db.ts';
import { env } from './env.ts';
import { isListedOperator } from './operator-guard.ts';

/** Client ids, also the env prefix: `temporal-ui` -> SSO_TEMPORAL_UI_SECRET. */
export const SSO_TOOLS = [
  'grafana',
  'temporal-ui',
  'langfuse',
  'vaultwarden',
  'glitchtip',
  'postiz',
  'oauth2-proxy',
] as const;

export const OPERATORS_GROUP = 'operators';

const envKey = (id: string, suffix: string) =>
  `SSO_${id.toUpperCase().replaceAll('-', '_')}_${suffix}`;

/** The configured clients, from the environment (read once). */
export const ssoClients = SSO_TOOLS.flatMap((id) => {
  const secret = process.env[envKey(id, 'SECRET')];
  const uris = (process.env[envKey(id, 'REDIRECT_URIS')] ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (!secret || !uris.length) return [];
  if (env.NODE_ENV === 'production' && (secret.length < 32 || secret.startsWith('local-dev'))) {
    throw new Error(`${envKey(id, 'SECRET')}: use a random value of 32+ characters`);
  }
  return [{ id, secret, redirectUris: uris }];
});
export const ssoClientIds = new Set<string>(ssoClients.map((c) => c.id));

/** Better Auth's stored form of a client secret (its default: SHA-256, base64url). */
const hashSecret = (s: string) => createHash('sha256').update(s).digest('base64url');

/**
 * Upserts the configured clients and disables the ones no longer configured, so removing the
 * env vars revokes a tool. Trusted first-party clients: no consent screen, PKCE optional (some
 * tools, e.g. Grafana's defaults, do not send it), secret at the token endpoint.
 */
export async function syncSsoClients() {
  const now = new Date();
  for (const c of ssoClients) {
    const row = {
      clientId: c.id,
      clientSecret: hashSecret(c.secret),
      name: c.id,
      redirectUris: c.redirectUris,
      scopes: ['openid', 'profile', 'email', 'groups'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      skipConsent: true,
      requirePKCE: false,
      disabled: false,
      metadata: TOOL_METADATA,
      updatedAt: now,
    };
    await db
      .insert(oauthClient)
      .values({ id: c.id, createdAt: now, ...row })
      .onConflictDoUpdate({ target: oauthClient.clientId, set: row });
  }
  const removed = SSO_TOOLS.filter((t) => !ssoClientIds.has(t));
  if (removed.length) {
    await db
      .update(oauthClient)
      .set({ disabled: true, updatedAt: now })
      .where(inArray(oauthClient.clientId, removed));
  }
  return { clients: ssoClients.length };
}

/** The client's metadata that marks a staff tool (its token needs an operator). */
export const TOOL_METADATA = { staffSso: true } as const;

/**
 * Claims for a token of a staff tool, or a refusal: only an operator now (the list, not a stored
 * role) with two-factor on, as for the operator console (docs/admin.md). The code was already
 * issued, but without these claims no token comes out.
 */
export function ssoClaims(
  u: { email: string; emailVerified: boolean; twoFactorEnabled?: boolean | null },
  isTool: boolean,
) {
  if (!isTool) return {};
  if (!isListedOperator(u)) throw new APIError('FORBIDDEN', { message: 'not an operator' });
  if (!u.twoFactorEnabled) {
    throw new APIError('FORBIDDEN', { message: 'turn on two-factor authentication first' });
  }
  return { groups: [OPERATORS_GROUP] };
}
