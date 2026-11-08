// Onboarding (docs/onboarding.md): the product tour and per-browser state. The tour uses
// driver.js (MIT), loaded on first use so it stays out of the entry chunk. Tours are data: steps
// per route, each pointing at a stable `data-tour` attribute.
import { track } from '@/lib/analytics';

/** Every `data-tour="..."` value a tour may point at. Add the attribute, then the id here. */
export type TourTarget = 'org-switcher' | 'new-project' | 'onboarding-checklist' | 'user-menu';
type TourStep = { element: TourTarget; title: string; description: string };

/** Tours keyed by route pattern. A step whose element is not on screen is shown centred. */
export const TOURS: Partial<Record<string, TourStep[]>> = {
  '/': [
    {
      element: 'org-switcher',
      title: 'Your organization',
      description:
        'Projects, members and files live inside an organization. Switch or add one here.',
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
  ],
};

// ponytail: per-browser state (no table, no migration): a user on a new device sees the tour once
// more and the checklist again. Move it to a user column if that matters.
export function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return 'blocked'; // storage blocked: treat as seen/dismissed, never nag
  }
}
export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
export const tourKey = (userId: string) => `onboarding-tour-seen:${userId}`;

/** Runs the tour of `route`; marks it seen for the user right away (closing counts as seen). */
export async function startTour(route: string, userId: string, manual = false) {
  const steps = TOURS[route];
  if (!steps) return;
  store(tourKey(userId), new Date().toISOString());
  const [{ driver }] = await Promise.all([
    import('driver.js'),
    import('driver.js/dist/driver.css'),
  ]);
  let step = 0;
  let finished = false;
  const tour = driver({
    popoverClass: 'app-tour',
    showProgress: true,
    steps: steps.map((s) => ({
      element: `[data-tour="${s.element}"]`,
      popover: { title: s.title, description: s.description },
    })),
    onHighlighted: () => {
      step = tour.getActiveIndex() ?? step;
    },
    onNextClick: () => {
      if (tour.isLastStep()) finished = true;
      tour.moveNext();
    },
    onDestroyed: () =>
      finished
        ? track('onboarding_tour_completed', { tour: route })
        : track('onboarding_tour_dismissed', { tour: route, step }),
  });
  track('onboarding_tour_started', { tour: route, manual });
  tour.drive();
}
