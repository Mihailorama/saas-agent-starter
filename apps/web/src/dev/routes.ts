import { type AnyRootRoute, createRoute, lazyRouteComponent } from '@tanstack/react-router';

/** Reference screens: every pattern assembled into a full page with fixture data. */
export const SCREENS = {
  list: 'List (projects)',
  detail: 'Detail',
  form: 'Create / edit form',
  settings: 'Settings',
  empty: 'Empty state',
  loading: 'Loading state',
  error: 'Error state',
} as const;
export type Screen = keyof typeof SCREENS;

// The DEV check sits right at each import() so the bundler drops the gallery chunks from
// production builds (a dead branch only in main.tsx would still emit them as orphan files).
const unavailable = () => Promise.reject(new Error('The UI gallery exists only in development'));
const loadGallery = import.meta.env.DEV ? () => import('./ui-gallery') : unavailable;
const loadScreens = import.meta.env.DEV ? () => import('./ui-screens') : unavailable;

/**
 * Dev-only UI gallery. Registered only when `import.meta.env.DEV` (main.tsx), so production
 * builds contain neither the routes nor the lazily imported gallery modules.
 */
export function devRoutes<R extends AnyRootRoute>(root: R) {
  const screen = <P extends `/dev/ui/screens/${Screen}`>(path: P) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: lazyRouteComponent(loadScreens, 'UiScreen'),
    });
  return [
    createRoute({
      getParentRoute: () => root,
      path: '/dev/ui',
      component: lazyRouteComponent(loadGallery, 'UiGallery'),
    }),
    screen('/dev/ui/screens/list'),
    screen('/dev/ui/screens/detail'),
    screen('/dev/ui/screens/form'),
    screen('/dev/ui/screens/settings'),
    screen('/dev/ui/screens/empty'),
    screen('/dev/ui/screens/loading'),
    screen('/dev/ui/screens/error'),
  ] as const;
}
