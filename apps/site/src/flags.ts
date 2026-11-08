// Feature flags on the static site (docs/feature-flags.md): decided at build time, the same for
// every visitor. VITE_FLAGS_ON / VITE_FLAGS_OFF (the web's build-time overrides) first, then the
// catalog default. No PostHog: there is no signed-in user to roll out to; turn a flag on for the
// site with VITE_FLAGS_ON once it is fully rolled out in the app.
import catalog from '../../../config/flags.json' with { type: 'json' };

export type FlagName = keyof typeof catalog.flags;

const names = (s: string | undefined) => new Set((s ?? '').split(',').map((x) => x.trim()));

export function isEnabled(flag: FlagName, env: Record<string, string | undefined> = process.env) {
  if (names(env.VITE_FLAGS_ON).has(flag)) return true;
  if (names(env.VITE_FLAGS_OFF).has(flag)) return false;
  return catalog.flags[flag].default;
}
