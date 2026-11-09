// "Book a demo" (site) and "Talk to us" (app), docs/crm.md. Booking links are plain links to the
// booking page of the self-hosted Cal.diy (or Cal.com Cloud); when the visitor has allowed the
// booking calendar in the consent banner, a click opens its embed in a modal instead. Off while
// VITE_BOOKING_ORIGIN or VITE_BOOKING_LINK is empty; shown only with the `booking` flag on (the
// callers check it). Shared with apps/site like analytics.ts, hence the relative import.
import { allowed, track } from './analytics';

const env = import.meta.env;
/** The booking host: your Cal.diy (e.g. https://cal.example.com) or https://app.cal.com. */
const origin = ((env.VITE_BOOKING_ORIGIN as string | undefined) ?? '').replace(/\/+$/, '');
/** `<user>/<event type>`, e.g. `acme/demo`. */
const calLink = env.VITE_BOOKING_LINK as string | undefined;
export const bookingUrl = origin && calLink ? `${origin}/${calLink}` : undefined;

type Cal = ((...args: unknown[]) => void) & { q?: unknown[]; ns?: object; loaded?: boolean };
type Win = Window & { Cal?: Cal };
const w = window as Win;
let source: 'site' | 'app' = 'app';
let cal: Promise<Cal> | undefined;

/** Cal.com's loader snippet, without namespaces: queue calls until embed.js takes them over. */
function load(): Promise<Cal> {
  cal ??= new Promise((resolve, reject) => {
    const q: unknown[] = [];
    w.Cal = Object.assign((...args: unknown[]) => void q.push(args), { q, ns: {}, loaded: true });
    w.Cal('init', { origin });
    w.Cal('on', {
      action: 'bookingSuccessfulV2',
      callback: () => track('booking_completed', { source }),
    });
    const script = Object.assign(document.createElement('script'), {
      src: `${origin}/embed/embed.js`,
      async: true,
      onload: () => resolve(w.Cal!),
      onerror: () => {
        cal = undefined;
        reject(new Error('booking embed failed to load'));
      },
    });
    document.head.append(script);
  });
  return cal;
}

/**
 * Click handler for a booking link (`href={bookingUrl}`, `target="_blank"`). Without consent the
 * browser follows the link; with it, the embed opens in a modal. Prefill only for signed-in users.
 */
export function onBookingClick(
  e: { preventDefault: () => void },
  from: 'site' | 'app',
  prefill: { name?: string; email?: string } = {},
) {
  source = from;
  track('booking_opened', { source });
  if (!calLink || !allowed('booking')) return;
  e.preventDefault();
  load()
    .then((c) => c('modal', { calLink, config: prefill }))
    .catch(() => window.open(bookingUrl, '_blank', 'noopener'));
}
