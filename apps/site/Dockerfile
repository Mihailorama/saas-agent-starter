FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/site/package.json apps/site/
# The site reuses the web app's tokens (index.css) and analytics.ts, so it needs their deps too.
RUN pnpm install --frozen-lockfile --filter site... --filter web...
COPY apps/web/src/index.css apps/web/src/
COPY apps/web/src/lib/analytics.ts apps/web/src/lib/booking.ts apps/web/src/lib/
COPY apps/site apps/site
COPY config config
ENV ASTRO_TELEMETRY_DISABLED=1
# Canonical origin, app link and optional share image / IndexNow key (docs/marketing.md).
ARG SITE_URL= SITE_APP_URL= SITE_OG_IMAGE= SITE_TWITTER= SITE_NOINDEX= INDEXNOW_KEY=
# Same analytics sinks as the web app; all empty = no analytics requests.
ARG VITE_RELEASE=dev VITE_POSTHOG_KEY= VITE_POSTHOG_HOST= VITE_UMAMI_SCRIPT_URL= \
    VITE_UMAMI_WEBSITE_ID= VITE_GA4_ID=
# "Book a demo" (Cal.diy / Cal.com, docs/crm.md): shown with both set and the `booking` flag on
# (VITE_FLAGS_ON=booking; the site decides flags at build time, apps/site/src/flags.ts).
ARG VITE_BOOKING_ORIGIN= VITE_BOOKING_LINK= VITE_FLAGS_ON= VITE_FLAGS_OFF=
RUN pnpm --filter site build

# Static files only; runs as non-root on port 8080.
FROM nginxinc/nginx-unprivileged:1.29-alpine
# Space-separated origins of the enabled analytics sinks, added to the CSP (empty = none).
ENV ANALYTICS_ORIGINS=""
# Consent regime, as in the web container (docs/product-analytics.md#consent).
ENV CONSENT_MODE=opt-in CONSENT_COUNTRY_HEADER=cf_ipcountry CONSENT_OPT_OUT_COUNTRIES=""
# Origin of the booking embed (Cal.diy / Cal.com), as in the web container (empty = none).
ENV BOOKING_ORIGINS=""
COPY apps/site/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/site/dist /usr/share/nginx/html
EXPOSE 8080
