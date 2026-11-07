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

initAnalytics();
// Static pages have no ids in their paths, so the path is the route.
page(location.pathname);

const choices = document.getElementById('privacy-choices');
if (choices && privacyChoicesLabel) {
  choices.textContent = privacyChoicesLabel;
  choices.hidden = false;
  choices.addEventListener('click', showPrivacyChoices);
}

// Links with data-cta="<id>" (sign-in, start free...) are the site's conversions.
document.addEventListener('click', (e) => {
  const cta = (e.target as HTMLElement).closest<HTMLElement>('[data-cta]')?.dataset.cta;
  if (cta) track('site_cta_clicked', { cta });
});
