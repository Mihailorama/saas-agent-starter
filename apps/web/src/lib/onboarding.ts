// Onboarding (docs/onboarding.md): the product tour and per-browser state. The tour uses
// driver.js (MIT), loaded on first use so it stays out of the entry chunk. The tour is data: each
// step points at a stable `data-tour` attribute on the projects page or the shell.
import { track } from '@/lib/analytics';

/** The tour, shown on the projects page (`/`). A step whose element is not on screen is centred. */
export const TOUR = [
  {
    element: 'org-switcher',
    title: 'Your organization',
    description: 'Projects, members and files live inside an organization. Switch or add one here.',
  },
  {
    element: 'new-project',
    title: 'Create a project',
    description: 'Projects are where your organization’s work lives.',
  },
  {
    element: 'onboarding-checklist',
    title: 'Get set up',
    description: 'A few steps that make the most of your account. Each ticks off by itself.',
  },
  {
    element: 'user-menu',
    title: 'Your account',
    description: 'Security, privacy and this tour are in this menu.',
  },
];

// ponytail: per-browser state (no table, no migration): a user on a new device sees the tour once
// more and the checklist again. Move it to a user column if that matters (docs/TODO.md).
/** The stored value; `undefined` when storage is blocked (private mode, policy). */
export function stored(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}
export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
export const tourKey = (userId: string) => `onboarding-tour-seen:${userId}`;

/** Runs the tour; marks it seen for the user right away (closing counts as seen). */
export async function startTour(userId: string, manual = false) {
  store(tourKey(userId), new Date().toISOString());
  const [{ driver }] = await Promise.all([
    import('driver.js'),
    import('driver.js/dist/driver.css'),
  ]);
  const tour = driver({
    popoverClass: 'app-tour',
    showProgress: true,
    steps: TOUR.map(({ element, title, description }) => ({
      element: `[data-tour="${element}"]`,
      popover: { title, description },
    })),
    // Done, Esc or the close button: closed on the last step counts as completed.
    onDestroyStarted: () => {
      if (tour.isLastStep()) track('onboarding_tour_completed');
      else track('onboarding_tour_dismissed', { step: tour.getActiveIndex() ?? 0 });
      tour.destroy();
    },
  });
  track('onboarding_tour_started', { manual });
  tour.drive();
}
