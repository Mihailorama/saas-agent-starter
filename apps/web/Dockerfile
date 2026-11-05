FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter web...
COPY apps/web apps/web
COPY config config
RUN pnpm --filter web build

# Static files + /api reverse proxy; runs as non-root on port 8080.
FROM nginxinc/nginx-unprivileged:1.29-alpine
ENV S3_PUBLIC_ORIGIN=http://localhost:8333
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
