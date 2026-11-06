// Browser errors over the Sentry protocol (Sentry or GlitchTip). Off unless VITE_SENTRY_DSN is
// set at build time. No tracing, replay or PII: stack traces plus the page path only.
import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    // SDK 11 collects user info, headers, bodies and query params by default: switch all off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
    beforeSend(event) {
      if (event.request?.url) event.request = { url: event.request.url.split(/[?#]/)[0] };
      delete event.user;
      delete event.extra;
      return event;
    },
    // Breadcrumbs of typed text and fetch bodies could hold user content; keep navigation only.
    beforeBreadcrumb: (b) => (b.category === 'navigation' ? b : null),
  });
}
