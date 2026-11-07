import { createHash, randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/node-core';
import { fromNodeHeaders } from 'better-auth/node';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { auth, ssoEnabled } from './auth.ts';
import { db } from './db.ts';
import { allowedOrigins, env } from './env.ts';
import { READ_ONLY } from './operator-guard.ts';
import { adminRoutes, impersonationRoutes } from './routes/admin.ts';
import { aiCallRoutes } from './routes/ai-calls.ts';
import { aiProviderRoutes } from './routes/ai-providers.ts';
import { apiKeyRoutes } from './routes/api-keys.ts';
import { billingRoutes, billingWebhookRoutes } from './routes/billing.ts';
import { crmHookRoutes } from './routes/crm.ts';
import { hookRoutes } from './routes/hooks.ts';
import { privacyRoutes } from './routes/privacy.ts';
import { projectRoutes } from './routes/projects.ts';
import { securityRoutes } from './routes/security.ts';
import { supportHookRoutes, supportRoutes } from './routes/support.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { redactUrl } from './sentry.ts';
import { bearerToken } from './tenant.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp() {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    logger: {
      level: env.LOG_LEVEL,
      // trace_id/span_id on every line inside a span: Grafana links Loki lines to Jaeger traces.
      formatters: { level: (label) => ({ level: label }) }, // "info", not 30: Loki detects it
      mixin: () => {
        const ctx = trace.getActiveSpan()?.spanContext();
        return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
      redact: { paths: ['*.password', '*.token', '*.secret', '*.cookie', '*.authorization'] },
      serializers: {
        // Never log query strings or reset tokens (mailed auth links carry them) or headers.
        req: (req) => ({ method: req.method, url: redactUrl(req.url), ip: req.ip }),
      },
    },
  }).withTypeProvider<ZodTypeProvider>();

  // 5xx and unexpected errors to the error tracker (no-op without SENTRY_DSN). Runs inside the
  // request's span, so the event carries its trace_id (sentry.ts).
  app.addHook('onError', async (_req, _reply, err) => {
    if ((err.statusCode ?? 500) >= 500) Sentry.captureException(err);
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('tenant');
  app.decorateRequest('operator');

  // Redis store: limits hold across API replicas.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  app.addHook('onClose', async () => {
    await redis.quit();
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  await app.register(rateLimit, { global: false, redis });
  await app.register(swagger, {
    openapi: {
      info: { title: 'API', version: '1.0.0' },
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer', description: 'Organization API key (sk_...)' },
          session: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
        },
      },
    },
    // Routes declared with access(scope) (tenant.ts) accept API keys: document that here.
    transform: (args) => {
      const out = jsonSchemaTransform(args);
      const scope = args.route.config?.scope;
      if (!scope) return out;
      const schema = out.schema as { description?: string };
      return {
        ...out,
        schema: {
          ...out.schema,
          security: [{ apiKey: [] }, { session: [] }],
          description: [schema.description, `API key scope: \`${scope}\`.`]
            .filter(Boolean)
            .join(' '),
        },
      };
    },
  });

  // Public API routes (access(scope)): every request with an API key counts against that key's
  // limit (Redis, so it holds across replicas), valid key or not. Other routes keep their own
  // limits (the plugin runs one limiter per request, so this must not touch them).
  const perKey = app.rateLimit({
    max: env.API_KEY_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (req) =>
      `apikey:${createHash('sha256')
        .update(bearerToken(req) ?? '')
        .digest('base64url')}`,
  });
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.config?.scope && bearerToken(req)) return perKey.call(app, req, reply);
  });

  // CSRF defense in depth (cookies are already SameSite=Lax): browsers always
  // send Origin on cross-site unsafe requests; reject unknown ones.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (UNSAFE.has(req.method) && origin && !allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
  });

  // "View as user" is read-only on every route, also ones added later (docs/admin.md): one guard
  // for all mutating requests with a session. Better Auth's endpoints have their own (/api/auth/*,
  // operator-guard.ts), and leaving the view must work.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url ?? '';
    if (!UNSAFE.has(req.method) || !req.headers.cookie || bearerToken(req)) return;
    if (url.startsWith('/api/auth/') || url === '/api/impersonation/stop') return;
    const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (s?.session.impersonatedBy) return reply.code(403).send({ error: READ_ONLY });
  });

  // Lets the web attach the trace id to analytics error events (docs/product-analytics.md).
  app.addHook('onSend', async (_req, reply) => {
    const ctx = trace.getActiveSpan()?.spanContext();
    if (ctx && isSpanContextValid(ctx)) reply.header('x-trace-id', ctx.traceId);
  });

  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));
  if (env.NODE_ENV !== 'production') {
    // Dev only: proves error reporting end to end (an event with stack trace and trace_id).
    app.get('/api/debug/error', { schema: { hide: true } }, async () => {
      throw new Error('debug: test error from the API');
    });
  }
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await Promise.all([db.execute(sql`select 1`), redis.ping()]);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // Better Auth owns /api/auth/*; sign-in/up and the routes that send mail get a stricter limit.
  const authHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const headers = fromNodeHeaders(req.headers);
    headers.delete('content-length');
    // Better Auth reads the client IP from here (sessions, audit_log in mfa.ts): use Fastify's
    // TRUST_PROXY-aware value, never a header the client made up.
    headers.set('x-forwarded-for', req.ip);
    const res = await auth.handler(
      new Request(new URL(req.url, env.BETTER_AUTH_URL), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      }),
    );
    reply.code(res.status);
    res.headers.forEach((value, key) => {
      if (key !== 'set-cookie') reply.header(key, value);
    });
    const cookies = res.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null);
  };
  const authRoute = (url: string, max: number, method: ('GET' | 'POST')[]) =>
    app.route({
      method,
      url,
      schema: { hide: true },
      config: { rateLimit: { max, timeWindow: '1 minute' } },
      handler: authHandler,
    });
  // Public: tells the sign-in page whether to offer "Sign in with SSO".
  app.get('/api/auth-config', { schema: { hide: true } }, async () => ({ sso: ssoEnabled }));
  authRoute('/api/auth/*', 300, ['GET', 'POST']);
  // API keys are managed through /api/api-keys (scopes, audit log), not the plugin's endpoints.
  app.all('/api/auth/api-key/*', { schema: { hide: true } }, async (_req, reply) =>
    reply.code(404).send({ error: 'not found' }),
  );
  // Operator actions go through /api/admin (reason, audit log), not the admin plugin's endpoints.
  app.all('/api/auth/admin/*', { schema: { hide: true } }, async (_req, reply) =>
    reply.code(404).send({ error: 'not found' }),
  );
  authRoute('/api/auth/sign-in/*', 10, ['POST']);
  authRoute('/api/auth/sign-up/*', 10, ['POST']);
  // Second factors and passkey sign-in (the twoFactor plugin also locks the account itself).
  authRoute('/api/auth/two-factor/*', 10, ['POST']);
  authRoute('/api/auth/passkey/verify-authentication', 10, ['POST']);
  authRoute('/api/auth/request-password-reset', 10, ['POST']);
  authRoute('/api/auth/send-verification-email', 10, ['POST']);

  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(aiCallRoutes, { prefix: '/api/orgs/:orgId/ai-calls' });
  await app.register(aiProviderRoutes, { prefix: '/api/ai-providers' });
  await app.register(hookRoutes, { prefix: '/api/hooks' });
  await app.register(billingRoutes, { prefix: '/api/billing' });
  await app.register(billingWebhookRoutes, { prefix: '/api/billing/webhooks' });
  await app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });
  await app.register(securityRoutes, { prefix: '/api/security' });
  await app.register(supportHookRoutes, { prefix: '/api/hooks' });
  await app.register(crmHookRoutes, { prefix: '/api/hooks' });
  await app.register(supportRoutes, { prefix: '/api/support' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(impersonationRoutes, { prefix: '/api/impersonation' });
  await app.register(privacyRoutes, { prefix: '/api/privacy' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  // Same spec under /api, which the web origin proxies: what API customers can reach.
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
