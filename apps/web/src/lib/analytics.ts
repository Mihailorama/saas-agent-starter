// Product analytics: one typed `track()` that fans out to the sinks configured by env.
// Every sink is optional; with no env set nothing loads and no request is made.
// - Umami (self-hosted, cookieless): loads right away, gets every event.
// - PostHog, GA4, Yandex Metrika (third parties): load only after the user consents
//   (vanilla-cookieconsent; opt-out regime only where the deployment says so),
//   never receive events marked `pii` in config/events.json.
// - Formbricks (connect your own instance, docs/product-analytics.md#surveys): in-app surveys
//   for the self-hosted contour; same consent gate, identified by user/org id only.
// Rage/dead clicks, web vitals and exceptions come from PostHog autocapture, not from here.
// Catalog, tiers and replacement criteria: docs/product-analytics.md.
import catalog from '../../../../config/events.json';
import flags from '../../../../config/flags.json';
import journeys from '../../../../config/journeys.json';

export type EventName = keyof typeof catalog.events;
export type Props = Record<string, string | number | boolean>;

const env = import.meta.env;
const config = {
  release: env.VITE_RELEASE || 'dev',
  umami: { src: env.VITE_UMAMI_SCRIPT_URL, websiteId: env.VITE_UMAMI_WEBSITE_ID },
  posthog: { key: env.VITE_POSTHOG_KEY, host: env.VITE_POSTHOG_HOST },
  posthogAiSurvey: {
    id: env.VITE_POSTHOG_AI_FEEDBACK_SURVEY_ID,
    question: env.VITE_POSTHOG_AI_FEEDBACK_QUESTION_ID,
  },
  ga4: env.VITE_GA4_ID,
  ym: { id: env.VITE_YM_ID, webvisor: env.VITE_YM_WEBVISOR === 'true' },
  langfuse: { key: env.VITE_LANGFUSE_PUBLIC_KEY, host: env.VITE_LANGFUSE_HOST },
  formbricks: { envId: env.VITE_FORMBRICKS_ENV_ID, host: env.VITE_FORMBRICKS_API_HOST },
};

/** A sink maps `page_view` to its native page view and everything else to a custom event. */
type Sink = (name: string, props: Props) => void;
type Win = Window & {
  umami?: { track: (arg?: unknown, data?: Props) => void };
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  ym?: ((...args: unknown[]) => void) & { a?: unknown[]; l?: number };
};
const w = window as Win;

const formbricksOn = Boolean(config.formbricks.envId && config.formbricks.host);
const analyticsNeedsConsent = Boolean(
  config.posthog.key || config.ga4 || config.ym.id || formbricksOn,
);
/** The booking embed (lib/booking.ts) loads a third party into the page: ask first, when it can
 * show at all: configured, and its `booking` flag not off for everyone (same order as lib/flags). */
const listed = (names: string | undefined) =>
  (names ?? '').split(',').some((n) => n.trim() === 'booking');
const bookingNeedsConsent =
  Boolean(env.VITE_BOOKING_ORIGIN && env.VITE_BOOKING_LINK) &&
  (listed(env.VITE_FLAGS_ON) ||
    (!listed(env.VITE_FLAGS_OFF) && (flags.flags.booking.default || Boolean(config.posthog.key))));
/** True when the consent banner has something to ask. */
const consentNeeded = analyticsNeedsConsent || bookingNeedsConsent;
// Regime per request: nginx writes the meta tag from CONSENT_MODE or the edge's country header
// (docs/product-analytics.md#consent). Anything else, the Vite dev server included: opt-in.
const consentMode =
  document.querySelector<HTMLMetaElement>('meta[name="consent-mode"]')?.content === 'opt-out'
    ? 'opt-out'
    : 'opt-in';
/** Label of the link that reopens the consent choices; undefined when there is nothing to choose. */
export const privacyChoicesLabel = !consentNeeded
  ? undefined
  : consentMode === 'opt-out'
    ? 'Do Not Sell or Share My Personal Information'
    : 'Cookie settings';
export const showPrivacyChoices = async () =>
  (await import('vanilla-cookieconsent')).showPreferences();

let consent: typeof import('vanilla-cookieconsent') | undefined;
/** Whether the visitor allowed a consent category (false until the banner has loaded). */
export const allowed = (category: 'booking') => consent?.acceptedCategory(category) ?? false;

const firstParty: Sink[] = [];
const thirdParty: Sink[] = [];
let posthog: typeof import('posthog-js').default | undefined;
let posthogLoaded: (ph: typeof import('posthog-js').default) => void = () => {};
/** Resolves once PostHog is initialised (after consent); feature flags read it (lib/flags.ts). */
export const posthogReady = new Promise<typeof import('posthog-js').default>((resolve) => {
  posthogLoaded = resolve;
});

/** Who is signed in (internal ids only), applied to PostHog and Formbricks once they load. */
let who: { userId: string; orgId?: string } | undefined;
let formbricks: typeof import('@formbricks/js').default | undefined;
function applyIdentity() {
  if (!who) return;
  // first_seen_at: survey targeting "active for N days" (config/journeys.json activeForDays).
  posthog?.identify(who.userId, undefined, { first_seen_at: new Date().toISOString() });
  void formbricks?.setUserId(who.userId); // contact targeting: Formbricks Enterprise
  if (who.orgId) void formbricks?.setAttribute('orgId', who.orgId);
}

function loadScript(src: string, attrs: Record<string, string> = {}, onload?: () => void) {
  const s = Object.assign(document.createElement('script'), { src, async: true, onload });
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.head.append(s);
}

function umamiSink(): Sink {
  // Calls made before the script has loaded are replayed once it is ready.
  const pending: (() => void)[] = [];
  const run = (fn: () => void) => (w.umami ? fn() : pending.push(fn));
  // Manual page views so Umami stores the route pattern, not URLs with ids in them.
  loadScript(
    config.umami.src!,
    {
      'data-website-id': config.umami.websiteId!,
      'data-auto-track': 'false',
      'data-performance': 'true',
    },
    () => {
      for (const fn of pending.splice(0)) fn();
    },
  );
  return (name, props) =>
    run(() =>
      name === 'page_view'
        ? w.umami?.track((p: object) => ({ ...p, url: props.route, title: props.route }))
        : w.umami?.track(name, props),
    );
}

async function posthogSink(): Promise<Sink> {
  const { default: ph } = await import('posthog-js');
  ph.init(config.posthog.key!, {
    api_host: config.posthog.host,
    capture_pageview: false, // sent by page() with the route pattern
    autocapture: true, // clicks, incl. $rageclick
    capture_dead_clicks: true,
    capture_performance: { web_vitals: true },
    capture_exceptions: true,
    person_profiles: 'identified_only',
  });
  ph.register({ release: config.release });
  posthog = ph;
  applyIdentity();
  posthogLoaded(ph);
  return (name, props) => ph.capture(name === 'page_view' ? '$pageview' : name, props);
}

/** Survey trigger events in config/journeys.json, sent as Formbricks actions of the same key. */
const surveyTriggers = new Set<string>(
  journeys.surveys.map((s) => (s.trigger as { event?: string }).event ?? ''),
);
async function formbricksSink(): Promise<Sink> {
  const { default: fb } = await import('@formbricks/js');
  // VITE_FORMBRICKS_ENV_ID holds the Workspace ID. Not awaited: the SDK queues calls until its
  // script from the Formbricks host has loaded, and a failed load must not stop the other sinks.
  void fb.setup({ workspaceId: config.formbricks.envId!, appUrl: config.formbricks.host! });
  formbricks = fb;
  applyIdentity();
  return (name) => {
    if (name === 'page_view') void fb.registerRouteChange();
    else if (surveyTriggers.has(name)) void fb.track(name);
  };
}

function ga4Sink(): Sink {
  const id = config.ga4!;
  w.dataLayer ??= [];
  // gtag must push the `arguments` object itself, not an array (Google's snippet).
  w.gtag = function gtag() {
    // biome-ignore lint/complexity/noArguments: required by gtag.js
    w.dataLayer!.push(arguments);
  };
  // Google Consent Mode v2, basic mode: gtag.js loads only after consent, so analytics storage
  // is granted when it runs. No ads category: the ad signals stay denied.
  const denied = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
  w.gtag('consent', 'default', { ...denied, analytics_storage: 'denied' });
  w.gtag('consent', 'update', { analytics_storage: 'granted' });
  w.gtag('js', new Date());
  w.gtag('config', id, { send_page_view: false });
  loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
  return (name, props) =>
    name === 'page_view'
      ? w.gtag!('event', 'page_view', { page_path: props.route })
      : w.gtag!('event', name, props);
}

function ymSink(): Sink {
  const id = Number(config.ym.id);
  // Yandex's stub: queues calls until tag.js loads.
  w.ym ??= Object.assign(
    function ym() {
      w.ym!.a ??= [];
      // biome-ignore lint/complexity/noArguments: required by tag.js
      w.ym!.a.push(arguments);
    },
    { l: Date.now() },
  );
  loadScript('https://mc.yandex.ru/metrika/tag.js');
  w.ym(id, 'init', {
    defer: true,
    clickmap: true,
    trackLinks: true,
    accurateTrackBounce: true,
    webvisor: config.ym.webvisor,
  });
  return (name, props) =>
    name === 'page_view' ? w.ym!(id, 'hit', props.route) : w.ym!(id, 'reachGoal', name, props);
}

let thirdPartyStarted = false;
async function startThirdParty() {
  if (thirdPartyStarted) return;
  thirdPartyStarted = true;
  if (config.ga4) thirdParty.push(ga4Sink());
  if (config.ym.id) thirdParty.push(ymSink());
  if (config.posthog.key) thirdParty.push(await posthogSink());
  if (formbricksOn) thirdParty.push(await formbricksSink());
  if (lastRoute) for (const send of thirdParty) send('page_view', { route: lastRoute });
}

/**
 * Consent banner and preferences (vanilla-cookieconsent). opt-in: sinks start only after
 * "Allow"; opt-out: they start right away unless the browser sends Global Privacy Control.
 * Withdrawing clears the sinks' cookies and reloads the page, so nothing keeps running.
 */
async function startConsent() {
  const [cc] = await Promise.all([
    import('vanilla-cookieconsent'),
    import('vanilla-cookieconsent/dist/cookieconsent.css'),
  ]);
  consent = cc;
  const apply = () => {
    if (cc.acceptedCategory('analytics')) void startThirdParty();
  };
  const answered = () => {
    track('consent_set', { analytics: cc.acceptedCategory('analytics') });
    apply();
  };
  await cc.run({
    mode: consentMode,
    respectGpc: true,
    categories: {
      necessary: { enabled: true, readOnly: true },
      analytics: {
        enabled: consentMode === 'opt-out',
        autoClear: {
          cookies: [{ name: /^_ga/ }, { name: /^_ym/ }, { name: /^ph_/ }],
          reloadPage: true,
        },
      },
      ...(bookingNeedsConsent && { booking: { enabled: consentMode === 'opt-out' } }),
    },
    onFirstConsent: answered,
    onChange: answered,
    language: {
      default: 'en',
      translations: {
        en: {
          consentModal: {
            title: analyticsNeedsConsent ? 'Usage analytics' : 'Booking calendar',
            description: [
              analyticsNeedsConsent &&
                'We use analytics to see where the product works and where it gets in your way.',
              bookingNeedsConsent &&
                'Our booking calendar comes from Cal.com and loads only if you allow it.',
            ]
              .filter(Boolean)
              .join(' '),
            acceptAllBtn: 'Allow',
            acceptNecessaryBtn: 'Only necessary',
            showPreferencesBtn: 'Choose',
          },
          preferencesModal: {
            title: 'Privacy choices',
            acceptAllBtn: 'Allow all',
            acceptNecessaryBtn: 'Only necessary',
            savePreferencesBtn: 'Save choices',
            closeIconLabel: 'Close',
            sections: [
              {
                title: 'Necessary',
                description: 'Sign-in and security. Always on.',
                linkedCategory: 'necessary',
              },
              {
                title: 'Usage analytics',
                description:
                  'Product analytics services (for example PostHog or Google Analytics) that see' +
                  ' how the app is used. Turn this off to stop sharing your usage data with them.',
                linkedCategory: 'analytics',
              },
              ...(bookingNeedsConsent
                ? [
                    {
                      title: 'Booking calendar',
                      description:
                        'Cal.com shows its scheduling calendar inside this page. Off: booking links' +
                        ' open the calendar on Cal.com instead.',
                      linkedCategory: 'booking',
                    },
                  ]
                : []),
            ],
          },
        },
      },
    },
  });
  apply();
}

// Email addresses and UUIDs never leave the browser in event props.
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const scrub = (props: Props): Props =>
  Object.fromEntries(
    Object.entries(props).map(([k, v]) => [
      k,
      typeof v === 'string' ? v.replace(EMAIL, '[email]').replace(UUID, ':id').slice(0, 200) : v,
    ]),
  );

/**
 * Sends one catalogued event to every active sink. Names and props must match
 * config/events.json (checked by `pnpm check:events`); unknown props are dropped.
 */
export function track(name: EventName, props: Props = {}) {
  const spec = catalog.events[name] as { pii: boolean; props: Record<string, string> };
  const clean = scrub(Object.fromEntries(Object.entries(props).filter(([k]) => k in spec.props)));
  for (const send of firstParty) send(name, clean);
  if (!spec.pii) for (const send of thirdParty) send(name, clean);
}

let lastRoute: string | undefined;
/** Page view with the route pattern (e.g. /projects/$projectId). */
export function page(route: string) {
  if (route === lastRoute) return;
  lastRoute = route;
  track('page_view', { route });
}

/** Link to this session's PostHog replay ('' when PostHog is not loaded), for support requests. */
export const sessionReplayUrl = () =>
  posthog?.get_session_replay_url({ withTimestamp: true }) ?? '';

/**
 * GA4 client id of this browser (gtag's documented `get`), for GA4 user deletion when the user
 * deletes their account (docs/privacy.md). Undefined when GA4 is not loaded (no consent/config).
 */
export function gaClientId(): Promise<string | undefined> {
  const gtag = w.gtag;
  if (!gtag || !config.ga4) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 1000);
    gtag('get', config.ga4, 'client_id', (id: unknown) => {
      clearTimeout(timer);
      resolve(typeof id === 'string' && id ? id : undefined);
    });
  });
}

/** Ties later events and surveys to the signed-in user and org (internal ids only). */
export function identify(userId: string | undefined, orgId?: string) {
  who = userId ? { userId, orgId } : undefined;
  if (who) return applyIdentity();
  posthog?.reset();
  void formbricks?.logout();
}

/**
 * Thumbs up/down on an AI result. Goes to every configured target: the analytics event,
 * a Langfuse score and a PostHog AI-observability survey response, both on the trace id of
 * the LLM call (ai_calls.trace_id, the OpenTelemetry trace the gateway span belongs to).
 */
export async function aiFeedback(f: {
  purpose: string;
  aiCallId: string;
  traceId: string | null;
  up: boolean;
}) {
  track('ai_feedback', { purpose: f.purpose, rating: f.up ? 1 : -1, trace_id: f.traceId ?? '' });
  if (!f.traceId) return;
  const { id: surveyId, question } = config.posthogAiSurvey;
  if (posthog && surveyId && question) {
    posthog.capture('survey sent', {
      $survey_id: surveyId,
      [`$survey_response_${question}`]: f.up ? 1 : 2, // PostHog: 1 = thumbs up, 2 = thumbs down
      $ai_trace_id: f.traceId,
      $survey_submission_id: crypto.randomUUID(),
      $survey_completed: true,
    });
  }
  if (config.langfuse.key) {
    const { LangfuseBrowserClient } = await import('@langfuse/browser');
    const langfuse = new LangfuseBrowserClient({
      publicKey: config.langfuse.key,
      baseUrl: config.langfuse.host,
    });
    await langfuse.score({
      traceId: f.traceId,
      name: 'user_feedback',
      value: f.up ? 1 : 0,
      dataType: 'BOOLEAN',
      metadata: { purpose: f.purpose, aiCallId: f.aiCallId },
    });
  }
}

/** Starts the sinks allowed so far. Called once from main.tsx. */
export function initAnalytics() {
  if (config.umami.src && config.umami.websiteId) firstParty.push(umamiSink());
  if (consentNeeded) void startConsent();
  // Browser validation that blocked a submit: field name and reason only, never the value.
  document.addEventListener(
    'invalid',
    (e) => {
      const el = e.target as HTMLInputElement;
      const reason = Object.keys(ValidityState.prototype).find(
        (k) => k !== 'valid' && el.validity?.[k as keyof ValidityState],
      );
      track('form_error', {
        form: el.form?.getAttribute('aria-label') ?? el.form?.id ?? '',
        field: el.name || el.id,
        reason: reason ?? 'invalid',
      });
    },
    true,
  );
}
