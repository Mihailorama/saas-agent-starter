import { z } from 'zod';

const list = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url(),
    /** Redis store for rate limiting. */
    REDIS_URL: z.string().default('redis://localhost:6379'),
    TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    TEMPORAL_TASK_QUEUE: z.string().default('projects'),
    S3_ENDPOINT: z.url().optional(),
    /** Endpoint browsers use for presigned URLs; defaults to S3_ENDPOINT. */
    S3_PUBLIC_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('attachments'),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    /** Set to true behind a reverse proxy so req.ip comes from X-Forwarded-For. */
    TRUST_PROXY: z.stringbool().default(false),
    BETTER_AUTH_SECRET: z.string().min(32),
    /** Public origin users reach the app on (web origin; /api is proxied there). */
    BETTER_AUTH_URL: z.url(),
    /** Extra browser origins allowed to call the API with credentials. */
    CORS_ORIGINS: list,
    OTEL_EXPORTER_OTLP_ENDPOINT: z.union([z.url(), z.literal('')]).optional(),
    /** Error tracking (Sentry protocol: Sentry or GlitchTip); empty = off. Read in sentry.ts. */
    SENTRY_DSN: z.union([z.url(), z.literal('')]).optional(),
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
  })
  .refine((e) => e.NODE_ENV !== 'production' || !e.BETTER_AUTH_SECRET.startsWith('change-me'), {
    message: 'BETTER_AUTH_SECRET still has the example value',
    path: ['BETTER_AUTH_SECRET'],
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
export const allowedOrigins = [new URL(env.BETTER_AUTH_URL).origin, ...env.CORS_ORIGINS];
