// The web app's analytics, unchanged: same track(), consent rule and sinks (env VITE_*), so
// site visits and app sign-ups land in one PostHog/Umami project (docs/marketing.md).
import {
  consent,
  consentNeeded,
  initAnalytics,
  page,
  setConsent,
  track,
} from '../../../web/src/lib/analytics.ts';

initAnalytics();
// Static pages have no ids in their paths, so the path is the route.
page(location.pathname);

const banner = document.getElementById('consent');
if (banner && consentNeeded && consent() === undefined) {
  banner.hidden = false;
  banner.addEventListener('click', (e) => {
    const answer = (e.target as HTMLElement).closest('button')?.dataset.consent;
    if (!answer) return;
    setConsent(answer === 'granted');
    banner.hidden = true;
  });
}

// Links with data-cta="<id>" (sign-in, start free...) are the site's conversions.
document.addEventListener('click', (e) => {
  const cta = (e.target as HTMLElement).closest<HTMLElement>('[data-cta]')?.dataset.cta;
  if (cta) track('site_cta_clicked', { cta });
});
