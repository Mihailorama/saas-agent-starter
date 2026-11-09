// The web app's analytics, unchanged: same track(), consent banner (vanilla-cookieconsent, regime
// from nginx's consent-mode meta tag) and sinks (env VITE_*), so site visits and app sign-ups land
// in one PostHog/Umami project (docs/marketing.md).
import {
  initAnalytics,
  page,
  privacyChoicesLabel,
  showPrivacyChoices,
  track,
} from '../../../web/src/lib/analytics.ts';
import { onBookingClick } from '../../../web/src/lib/booking.ts';

initAnalytics();
// Static pages have no ids in their paths, so the path is the route.
page(location.pathname);

const choices = document.getElementById('privacy-choices');
if (choices && privacyChoicesLabel) {
  choices.textContent = privacyChoicesLabel;
  choices.hidden = false;
  choices.addEventListener('click', showPrivacyChoices);
}

// Links with data-cta="<id>" (GitHub, sign-in, book a demo...) are the site's conversions.
document.addEventListener('click', (e) => {
  const cta = (e.target as HTMLElement).closest<HTMLElement>('[data-cta]')?.dataset.cta;
  if (cta) track('site_cta_clicked', { cta });
  // "Book a demo" (data-booking): Cal.com's embed after consent, else the link (docs/crm.md).
  if ((e.target as HTMLElement).closest('[data-booking]')) onBookingClick(e, 'site');
});
