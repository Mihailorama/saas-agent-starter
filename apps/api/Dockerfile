# Runs TypeScript directly with Node's built-in type stripping (no build step).
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --prod --filter api...

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app ./
COPY packages/db packages/db
COPY apps/api apps/api
COPY config/webhook-events.json config/
ARG GIT_SHA=dev
ENV SENTRY_RELEASE=$GIT_SHA
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--import", "./apps/api/src/telemetry.ts", "apps/api/src/index.ts"]
