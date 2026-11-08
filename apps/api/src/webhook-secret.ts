import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env.ts';
import { httpError } from './tenant.ts';

/**
 * Webhook signing secrets at rest: AES-256-GCM under the first WEBHOOK_ENCRYPTION_KEYS entry,
 * bound to the endpoint id (additional data), stored as `v1:<key id>:<iv>:<ciphertext+tag>`
 * (base64). The API only encrypts: it shows a secret once, on create or rotate. Decryption lives
 * in the worker's signing path (services/worker-py/worker/webhooks.py), the format's twin.
 */
const [activeId = '', activeSecret = ''] = (env.WEBHOOK_ENCRYPTION_KEYS[0] ?? '').split(/:(.*)/s);
// The configured secret is already high-entropy; SHA-256 just fixes its length at 32 bytes.
const activeKey = createHash('sha256').update(activeSecret).digest();

export function encryptSecret(secret: string, endpointId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', activeKey, iv).setAAD(Buffer.from(endpointId));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1:${activeId}:${iv.toString('base64')}:${data.toString('base64')}`;
}

/** An org-owned row's secret at rest (BYO keys, MCP auth headers): bound to org and row id, plus
 * its last 4 characters to recognise it in settings. The worker decrypts it with the same AAD. */
export const sealSecret = (secret: string, orgId: string, id: string) => ({
  cipher: encryptSecret(secret, `${orgId}/${id}`),
  hint: secret.slice(-4),
});

/** A stored secret only goes where it was entered for: moving it (new URL or header) needs it
 * again, so nobody can redirect it to a host they control. */
export function requireSecretAgain(moved: boolean, stored: boolean, entered: boolean) {
  if (moved && stored && !entered) {
    throw httpError(400, 'enter the secret again when changing where it is sent');
  }
}

/** Standard Webhooks secret: `whsec_` + base64 of 24 random bytes. */
export const newSecret = () => `whsec_${randomBytes(24).toString('base64')}`;
