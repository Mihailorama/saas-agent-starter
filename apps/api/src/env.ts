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
    /** Task queue of the worker's SendEmailWorkflow (docs/email.md). */
    EMAIL_TASK_QUEUE: z.string().default('email'),
    /** Sign-in needs a confirmed email address. Off only for setups that verify elsewhere. */
    REQUIRE_EMAIL_VERIFICATION: z.stringbool().default(true),
    S3_ENDPOINT: z.url().optional(),
    /** Endpoint browsers use for presigned URLs; defaults to S3_ENDPOINT. */
    S3_PUBLIC_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('attachments'),
    /** Bucket the worker stores LLM request/response content in (worker AI_CONTENT_BUCKET). */
    AI_CONTENT_BUCKET: z.string().default('ai-calls'),
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
    /** Public API: requests per minute per API key (Redis, shared across replicas). */
    API_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
    /**
     * Keys that encrypt webhook signing secrets at rest: `id:secret,id:secret` (secret >= 32
     * chars, e.g. `openssl rand -base64 32`). The first one encrypts; the worker decrypts with
     * any of them and re-encrypts old rows with the first (docs/public-api.md, key rotation).
     */
    WEBHOOK_ENCRYPTION_KEYS: z
      .string()
      .min(1)
      .transform((s) => s.split(',').map((k) => k.trim()))
      .pipe(
        z
          .array(z.string().regex(/^[A-Za-z0-9_-]{1,32}:.{32,}$/, 'expected id:secret (32+ chars)'))
          .min(1),
      ),
    /** Outbound webhooks: largest JSON body publishEvent() accepts (the worker checks it too). */
    WEBHOOK_MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(65_536),
    /** Data-subject rights (docs/privacy.md): days a requested deletion waits, cancellable. */
    PRIVACY_DELETION_GRACE_DAYS: z.coerce.number().min(0).default(14),
    /** At most one data export per user or organization in this many hours. */
    PRIVACY_EXPORT_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
    /** Shown in authenticator apps (TOTP issuer) and passkey prompts (WebAuthn RP name). */
    APP_NAME: z.string().min(1).default('Workspace'),
    /** WebAuthn relying party: registrable domain, defaults to the BETTER_AUTH_URL host. */
    PASSKEY_RP_ID: z.string().min(1).optional(),
    /** Origin(s) passkey ceremonies run on, comma-separated; defaults to BETTER_AUTH_URL's. */
    PASSKEY_ORIGIN: list,
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    // Alert-to-issue loop (docs/product-analytics.md). Empty secret = webhook disabled (401);
    // no tracker credentials = dry run.
    POSTHOG_WEBHOOK_SECRET: z.string().optional(),
    /** PostHog app host for links in issues, e.g. https://eu.posthog.com */
    POSTHOG_APP_HOST: z.union([z.url(), z.literal('')]).optional(),
    POSTHOG_PROJECT_ID: z.string().optional(),
    // Feature flags (docs/feature-flags.md). Without POSTHOG_KEY a flag is its catalog default;
    // FLAGS_ON / FLAGS_OFF (comma-separated names) override everything, PostHog included.
    FLAGS_ON: list,
    FLAGS_OFF: list,
    /** PostHog project key (phc_...) and ingestion host, e.g. https://eu.i.posthog.com */
    POSTHOG_KEY: z.string().optional(),
    POSTHOG_HOST: z.union([z.url(), z.literal('')]).optional(),
    /** Optional project secret API key (feature_flag:read): local evaluation, no request per check. */
    POSTHOG_SECRET_KEY: z.string().optional(),
    // Tracker for alerts, feedback and support items (src/tracker.ts, docs/support.md).
    TRACKER: z.enum(['plane', 'github']).default('plane'),
    /** Plane API base (https://api.plane.so or self-hosted), workspace slug, project, API key. */
    PLANE_API_URL: z.string().optional(),
    /** Where humans open items, when it differs from PLANE_API_URL (e.g. https://app.plane.so). */
    PLANE_APP_URL: z.string().optional(),
    PLANE_WORKSPACE: z.string().optional(),
    PLANE_API_TOKEN: z.string().optional(),
    /**
     * Presidio PII sidecar (compose profile `pii`), e.g. http://pii:8000. Set: survey answers are
     * redacted there and the hook fails closed (503) when it is down. Empty: emails masked only.
     */
    PII_REDACT_URL: z.union([z.url(), z.literal('')]).optional(),
    /** Optional GitHub Issues tracker (TRACKER=github): fine-grained token, owner/name. */
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_REPO: z.string().optional(),
    // Billing (docs/billing.md). Contour of new subscriptions; config/plans.json `contours`.
    BILLING_CONTOUR: z.string().default('en'),
    /** Contour of config/ai-models.json: which cost currencies the billing page shows. */
    AI_CONTOUR: z.string().default(''),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    /** Only for stripe-mock in tests/dev, e.g. http://localhost:12111; empty = api.stripe.com. */
    STRIPE_API_URL: z.union([z.url(), z.literal('')]).optional(),
    // Service desk (docs/support.md). Every secret empty = that endpoint is off (401/404).
    /** Secret of the Chatwoot account webhook (Settings -> Integrations -> Webhooks). */
    CHATWOOT_WEBHOOK_SECRET: z.string().optional(),
    /** HMAC token of the Chatwoot website inbox (identity validation of logged-in users). */
    CHATWOOT_HMAC_TOKEN: z.string().optional(),
    /** Secret of the GitHub `issues` webhook (return path: closed issue -> conversation note). */
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    /** Secret of the Plane webhook (`plane_wh_...`) and the project whose work items count. */
    PLANE_WEBHOOK_SECRET: z.string().optional(),
    PLANE_PROJECT_ID: z.string().optional(),
  })
  .refine((e) => e.NODE_ENV !== 'production' || !e.BETTER_AUTH_SECRET.startsWith('change-me'), {
    message: 'BETTER_AUTH_SECRET still has the example value',
    path: ['BETTER_AUTH_SECRET'],
  })
  .refine(
    (e) =>
      e.NODE_ENV !== 'production' || !e.WEBHOOK_ENCRYPTION_KEYS.some((k) => /change-me/.test(k)),
    {
      message: 'WEBHOOK_ENCRYPTION_KEYS still has the example value',
      path: ['WEBHOOK_ENCRYPTION_KEYS'],
    },
  )
  .refine(
    (e) => e.NODE_ENV !== 'production' || !e.POSTHOG_WEBHOOK_SECRET?.startsWith('local-dev'),
    {
      message: 'POSTHOG_WEBHOOK_SECRET still has the example value',
      path: ['POSTHOG_WEBHOOK_SECRET'],
    },
  )
  .refine(
    (e) =>
      e.NODE_ENV !== 'production' ||
      ![e.CHATWOOT_WEBHOOK_SECRET, e.CHATWOOT_HMAC_TOKEN, e.GITHUB_WEBHOOK_SECRET].some((v) =>
        v?.startsWith('local-dev'),
      ),
    { message: 'a support secret still has an example value', path: ['CHATWOOT_WEBHOOK_SECRET'] },
  )
  .refine(
    (e) =>
      e.NODE_ENV !== 'production' ||
      ![e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET].some(
        (v) => v === 'sk_test_123' || v?.includes('local_dev'),
      ),
    { message: 'a billing secret still has the example value', path: ['STRIPE_SECRET_KEY'] },
  );

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
export const allowedOrigins = [new URL(env.BETTER_AUTH_URL).origin, ...env.CORS_ORIGINS];
