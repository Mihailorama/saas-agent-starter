import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { consent, consentNeeded, setConsent } from '@/lib/analytics';

/**
 * GDPR/ePrivacy: third-party analytics (PostHog, GA4, Yandex Metrika) load only after "Allow".
 * Shown only when one of them is configured; self-hosted Umami needs no banner (cookieless).
 */
export function ConsentBanner() {
  const [open, setOpen] = useState(consentNeeded && consent() === undefined);
  if (!open) return null;
  const answer = (granted: boolean) => {
    setConsent(granted);
    setOpen(false);
  };
  return (
    <section
      aria-label="Analytics consent"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-wrap items-center gap-3 rounded-lg border bg-background p-4 text-sm shadow-lg"
    >
      <p className="min-w-0 flex-1">
        We use analytics to see where the product works and where it gets in your way. Allow usage
        analytics?
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => answer(false)}>
          Only necessary
        </Button>
        <Button size="sm" onClick={() => answer(true)}>
          Allow
        </Button>
      </div>
    </section>
  );
}
