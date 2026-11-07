// Feature flags in the browser (docs/feature-flags.md, ADR 0020). Same rules as the API
// (apps/api/src/flags.ts): VITE_FLAGS_ON / VITE_FLAGS_OFF (build time) first, then PostHog, then
// the catalog default. PostHog loads only after analytics consent (lib/analytics.ts), so until
// then, and for users who decline, a flag is its catalog default.
import { useEffect, useSyncExternalStore } from 'react';
import catalog from '../../../../config/flags.json';
import { posthogReady } from './analytics';
import { authClient } from './auth';

export type FlagName = keyof typeof catalog.flags;
export type FlagContext = { userId: string; orgId?: string; plan?: string };

const names = (s: string | undefined) =>
  new Set(
    (s ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
const on = names(import.meta.env.VITE_FLAGS_ON);
const off = names(import.meta.env.VITE_FLAGS_OFF);
const defaults = catalog.flags as Record<string, { default: boolean } | undefined>;

let ph: Awaited<typeof posthogReady> | undefined;
const listeners = new Set<() => void>();
void posthogReady.then((p) => {
  ph = p;
  p.onFeatureFlags(() => {
    for (const notify of listeners) notify();
  });
});
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};

function read(flag: FlagName): boolean {
  if (on.has(flag)) return true;
  if (off.has(flag)) return false;
  return ph?.isFeatureEnabled(flag) ?? defaults[flag]?.default ?? false;
}

/** Points PostHog at the user (person) and organization (group); it reloads flags on change. */
function applyContext({ userId, orgId, plan }: FlagContext) {
  if (!ph) return;
  if (ph.get_distinct_id() !== userId) ph.identify(userId);
  if (orgId && ph.getGroups().organization !== orgId) {
    ph.group('organization', orgId, plan ? { plan } : undefined);
  }
}

/** For event handlers and other non-render code. */
export function isEnabled(flag: FlagName, ctx: FlagContext): boolean {
  applyContext(ctx);
  return read(flag);
}

/** For components: the signed-in user and active organization; re-renders when flags load. */
export function useFlag(flag: FlagName): boolean {
  const { data } = authClient.useSession();
  const userId = data?.user.id;
  const orgId = data?.session.activeOrganizationId ?? undefined;
  useEffect(() => {
    if (userId) applyContext({ userId, orgId });
  }, [userId, orgId]);
  return useSyncExternalStore(subscribe, () => read(flag));
}
