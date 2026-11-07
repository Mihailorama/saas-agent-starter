FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter web...
COPY apps/web apps/web
COPY config config
# Browser error reporting (public DSN, baked into the bundle; empty = off).
ARG VITE_SENTRY_DSN=
ARG VITE_SENTRY_RELEASE=dev
# Analytics sinks are compiled in; all empty = no analytics requests (docs/product-analytics.md).
ARG VITE_RELEASE=dev VITE_POSTHOG_KEY= VITE_POSTHOG_HOST= VITE_POSTHOG_AI_FEEDBACK_SURVEY_ID= \
    VITE_POSTHOG_AI_FEEDBACK_QUESTION_ID= VITE_UMAMI_SCRIPT_URL= VITE_UMAMI_WEBSITE_ID= \
    VITE_GA4_ID= VITE_YM_ID= VITE_YM_WEBVISOR= VITE_LANGFUSE_PUBLIC_KEY= VITE_LANGFUSE_HOST=
# Feature flag overrides (docs/feature-flags.md), comma-separated names.
ARG VITE_FLAGS_ON= VITE_FLAGS_OFF=
RUN pnpm --filter web build

# Static files + /api reverse proxy; runs as non-root on port 8080.
FROM nginxinc/nginx-unprivileged:1.29-alpine
ENV S3_PUBLIC_ORIGIN=http://localhost:8333 SENTRY_PUBLIC_ORIGIN=""
# Space-separated origins of the enabled analytics sinks, added to the CSP (empty = none).
ENV ANALYTICS_ORIGINS=""
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
