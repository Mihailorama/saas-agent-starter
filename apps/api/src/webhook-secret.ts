import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env.ts';

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

/** Standard Webhooks secret: `whsec_` + base64 of 24 random bytes. */
export const newSecret = () => `whsec_${randomBytes(24).toString('base64')}`;
