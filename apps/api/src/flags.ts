import { readFileSync } from 'node:fs';
import { PostHog } from 'posthog-node';
import { env } from './env.ts';

/**
 * Feature flags (docs/feature-flags.md, ADR 0020). One call for the API:
 * `await isEnabled('<literal name from config/flags.json>', { userId, orgId, plan })`.
 * Order: FLAGS_ON / FLAGS_OFF env, then PostHog (when POSTHOG_KEY is set), then the catalog
 * default. Same rules as the web (`apps/web/src/lib/flags.ts`) and the worker (`worker/flags.py`).
 */
export type FlagContext = { userId: string; orgId?: string; plan?: string };
type Catalog = Record<string, { default: boolean }>;
/** Remote decision for one flag; undefined = no answer (unknown, inactive, network error). */
type Remote = (flag: string, ctx: FlagContext) => Promise<boolean | undefined>;

export function flagEvaluator(
  catalog: Catalog,
  overrides: { on: string[]; off: string[] },
  remote?: Remote,
) {
  return async function isEnabled(flag: string, ctx: FlagContext): Promise<boolean> {
    const spec = catalog[flag];
    if (!spec) throw new Error(`unknown feature flag "${flag}": add it to config/flags.json`);
    if (overrides.on.includes(flag)) return true;
    if (overrides.off.includes(flag)) return false;
    const value = remote ? await remote(flag, ctx).catch(() => undefined) : undefined;
    return value ?? spec.default;
  };
}

/** PostHog decision: the user is the person, the organization a group (`organization`). */
export function posthogRemote(client: Pick<PostHog, 'evaluateFlags'>): Remote {
  return async (flag, { userId, orgId, plan }) => {
    const groups = orgId ? { organization: orgId } : undefined;
    const flags = await client.evaluateFlags(userId, {
      flagKeys: [flag],
      groups,
      groupProperties: groups && plan ? { organization: { plan } } : undefined,
    });
    const value = flags.getFlag(flag); // boolean, a variant string, or undefined
    return value === undefined ? undefined : Boolean(value);
  };
}

const catalog: Catalog = JSON.parse(
  readFileSync(new URL('../../../config/flags.json', import.meta.url), 'utf8'),
).flags;

// Remote evaluation needs only the public project key (one /flags request per check); a secret
// key switches posthog-node to local evaluation (definitions polled every 30 s).
const posthog = env.POSTHOG_KEY
  ? new PostHog(env.POSTHOG_KEY, {
      host: env.POSTHOG_HOST || undefined,
      secretKey: env.POSTHOG_SECRET_KEY || undefined,
    })
  : undefined;

export const isEnabled = flagEvaluator(
  catalog,
  { on: env.FLAGS_ON, off: env.FLAGS_OFF },
  posthog && posthogRemote(posthog),
);

/** Flushes queued $feature_flag_called events; called on app close. */
export const closeFlags = () => posthog?.shutdown();
