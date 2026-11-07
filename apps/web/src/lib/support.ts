// In-app help: the Chatwoot website widget (docs/support.md). Off and invisible while
// VITE_CHATWOOT_BASE_URL / VITE_CHATWOOT_WEBSITE_TOKEN are empty. The widget script loads only
// when the user opens Help, so nobody's browser talks to the service desk before they ask.
import { sessionReplayUrl, track } from '@/lib/analytics';
import { lastTraceId } from '@/lib/api';

const baseUrl = import.meta.env.VITE_CHATWOOT_BASE_URL as string | undefined;
const websiteToken = import.meta.env.VITE_CHATWOOT_WEBSITE_TOKEN as string | undefined;
export const supportEnabled = Boolean(baseUrl && websiteToken);

/** What the user picked in the Help menu; a hint for the triage, which decides itself. */
export type RequestKind = 'question' | 'bug' | 'feature_request';

// The SDK calls we use (Chatwoot's sdk.js, `window.$chatwoot`).
type Chatwoot = {
  toggle: (state?: 'open' | 'close') => void;
  setUser: (id: string, user: { name: string; email: string; identifier_hash: string }) => void;
  setCustomAttributes: (attrs: Record<string, string>) => void;
  setConversationCustomAttributes: (attrs: Record<string, string>) => void;
  reset: () => void;
};
type Win = Window & {
  $chatwoot?: Chatwoot;
  chatwootSDK?: { run: (o: { websiteToken: string; baseUrl: string }) => void };
  chatwootSettings?: Record<string, unknown>;
};
const w = window as Win;
type Identity = { identifier: string; identifierHash: string; name: string; email: string };

let widget: Promise<Chatwoot> | undefined;

/** Loads the widget once, without its own bubble (our Help menu opens it), and identifies the
 * signed-in user with the HMAC the API computed, so nobody can write as someone else. */
function load(): Promise<Chatwoot> {
  widget ??= new Promise((resolve, reject) => {
    w.chatwootSettings = { hideMessageBubble: true, position: 'right' };
    window.addEventListener(
      'chatwoot:ready',
      async () => {
        const cw = w.$chatwoot!;
        const res = await fetch('/api/support/identity', { credentials: 'include' }).catch(
          () => undefined,
        );
        if (res?.ok) {
          const id = (await res.json()) as Identity;
          cw.setUser(id.identifier, {
            name: id.name,
            email: id.email,
            identifier_hash: id.identifierHash,
          });
        }
        resolve(cw);
      },
      { once: true },
    );
    const script = Object.assign(document.createElement('script'), {
      src: `${baseUrl}/packs/js/sdk.js`,
      async: true,
      onload: () => w.chatwootSDK!.run({ websiteToken: websiteToken!, baseUrl: baseUrl! }),
      onerror: () => {
        widget = undefined;
        reject(new Error('support widget failed to load'));
      },
    });
    document.head.append(script);
  });
  return widget;
}

/** Opens the widget with the context support needs; empty values are left out. */
export async function openSupport(kind: RequestKind, orgId: string | undefined) {
  track('support_opened', { kind });
  const cw = await load();
  const attrs = Object.fromEntries(
    Object.entries({
      request_kind: kind,
      org_id: orgId ?? '',
      page: window.location.pathname, // no query string: auth flows put tokens there
      replay_url: sessionReplayUrl(),
      trace_id: lastTraceId() ?? '',
    }).filter(([, v]) => v),
  );
  // Contact attributes always stick; conversation ones only once a conversation exists.
  // The triage reads both (conversation first).
  cw.setCustomAttributes(attrs);
  cw.setConversationCustomAttributes(attrs);
  cw.toggle('open');
}

/** On sign-out: forget the widget's contact so the next user starts clean. */
export function resetSupport() {
  w.$chatwoot?.reset();
}
