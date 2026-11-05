import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
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
import { aiCallRoutes } from './routes/ai-calls.ts';
import { projectRoutes } from './routes/projects.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp() {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: ['*.password', '*.token', '*.secret', '*.cookie', '*.authorization'] },
      serializers: {
        // Never log query strings (auth flows put tokens there) or headers.
        req: (req) => ({ method: req.method, url: req.url.split('?')[0], ip: req.ip }),
      },
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('tenant');

  // Redis-compatible (Valkey) store: limits hold across API replicas.
  const redis = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 1 });
  app.addHook('onClose', async () => {
    await redis.quit();
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  await app.register(rateLimit, { global: false, redis });
  await app.register(swagger, {
    openapi: { info: { title: 'API', version: '1.0.0' } },
    transform: jsonSchemaTransform,
  });

  // CSRF defense in depth (cookies are already SameSite=Lax): browsers always
  // send Origin on cross-site unsafe requests; reject unknown ones.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (UNSAFE.has(req.method) && origin && !allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
  });

  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await Promise.all([db.execute(sql`select 1`), redis.ping()]);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // Better Auth owns /api/auth/*; sign-in/up get a stricter limit.
  const authHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const headers = fromNodeHeaders(req.headers);
    headers.delete('content-length');
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
  authRoute('/api/auth/sign-in/*', 10, ['POST']);
  authRoute('/api/auth/sign-up/*', 10, ['POST']);

  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(aiCallRoutes, { prefix: '/api/orgs/:orgId/ai-calls' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
