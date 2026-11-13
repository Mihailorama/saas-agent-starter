// The services in the box, for the landing's "What is in the box" (apps/site/src/pages/index.astro).
// Licenses and images come from docs/LICENSES.md; scripts/site-stack.test.mjs fails when an image
// there is missing here or a license differs, so the page cannot drift from the real stack.
// `icon` is a Simple Icons slug (CC0-1.0 data; the marks stay their owners' trademarks); without
// one the page shows the name's initial.
export type Tool = {
  name: string;
  role: string;
  /** SPDX-style license as docs/LICENSES.md has it; absent for a hosted service you only connect. */
  license?: string;
  /** Images from docs/LICENSES.md; empty for a tool the stack only connects to. */
  images: string[];
  icon?: string;
  href: string;
  /** What you can connect instead of (or, with no images, as) this one; docs/setup.md and the component docs. */
  connect?: string;
};

export const stack: { group: string; tools: Tool[] }[] = [
  {
    group: 'Data',
    tools: [
      {
        name: 'PostgreSQL',
        role: 'database, with pgvector',
        license: 'PostgreSQL',
        images: ['postgres'],
        icon: 'postgresql',
        href: 'https://www.postgresql.org',
        connect: 'Neon, Supabase, Amazon RDS or any PostgreSQL you run',
      },
      {
        name: 'Redis',
        role: 'rate limits and queues',
        license: 'RSALv2 / SSPLv1 / AGPLv3',
        images: ['redis'],
        icon: 'redis',
        href: 'https://redis.io',
      },
      {
        name: 'Valkey',
        role: 'Redis, permissive twin',
        license: 'BSD-3-Clause',
        images: ['valkey/valkey'],
        href: 'https://valkey.io',
      },
      {
        name: 'SeaweedFS',
        role: 'S3 storage in development',
        license: 'Apache-2.0',
        images: ['chrislusf/seaweedfs'],
        href: 'https://github.com/seaweedfs/seaweedfs',
        connect: 'AWS S3, Cloudflare R2 or any S3-compatible storage',
      },
      {
        name: 'Email',
        role: 'sign-in codes, invitations, product news',
        images: [],
        href: 'https://github.com/Mihailorama/saas-agent-starter/blob/main/docs/email.md',
        connect: 'Amazon SES, Mailgun or any SMTP server',
      },
    ],
  },
  {
    group: 'Work and AI',
    tools: [
      {
        name: 'Temporal',
        role: 'durable background jobs',
        license: 'MIT',
        images: ['temporalio/server', 'temporalio/admin-tools', 'temporalio/ui'],
        icon: 'temporal',
        href: 'https://temporal.io',
      },
      {
        name: 'vLLM',
        role: 'your own models on GPUs',
        license: 'Apache-2.0',
        images: ['vllm/vllm-openai', 'vllm/vllm-openai-cpu'],
        icon: 'vllm',
        href: 'https://vllm.ai',
      },
      {
        name: 'Ollama',
        role: 'local models in development',
        license: 'MIT',
        images: ['ollama/ollama'],
        icon: 'ollama',
        href: 'https://ollama.com',
      },
      {
        name: 'Langfuse',
        role: 'LLM traces and evals',
        license: 'MIT core + `ee/` commercial',
        images: ['langfuse/langfuse', 'langfuse/langfuse-worker'],
        href: 'https://langfuse.com',
        connect: 'Langfuse Cloud',
      },
      {
        name: 'ClickHouse',
        role: 'trace store for Langfuse',
        license: 'Apache-2.0',
        images: ['clickhouse/clickhouse-server'],
        icon: 'clickhouse',
        href: 'https://clickhouse.com',
      },
      {
        name: 'Promptfoo',
        role: 'prompt evals',
        license: 'MIT',
        images: ['ghcr.io/promptfoo/promptfoo'],
        href: 'https://www.promptfoo.dev',
      },
      {
        name: 'Model providers',
        role: 'every AI call goes through one gateway',
        images: [],
        href: 'https://github.com/Mihailorama/saas-agent-starter/blob/main/docs/llm-providers.md',
        connect:
          'Anthropic, OpenAI, Google Gemini, xAI, Moonshot, OpenRouter, your Claude Code, Codex or Gemini CLI subscription, or any OpenAI-compatible endpoint, such as your vLLM on Modal or RunPod',
      },
    ],
  },
  {
    group: 'Run',
    tools: [
      {
        name: 'Caddy',
        role: 'HTTPS and routing',
        license: 'Apache-2.0',
        images: ['caddy'],
        icon: 'caddy',
        href: 'https://caddyserver.com',
      },
      {
        name: 'NGINX',
        role: 'serves the web app',
        license: 'BSD-2-Clause',
        images: ['nginxinc/nginx-unprivileged'],
        icon: 'nginx',
        href: 'https://nginx.org',
      },
      {
        name: 'OpenTelemetry',
        role: 'traces, metrics and logs pipeline',
        license: 'Apache-2.0',
        images: ['otel/opentelemetry-collector-contrib'],
        icon: 'opentelemetry',
        href: 'https://opentelemetry.io',
      },
      {
        name: 'Prometheus',
        role: 'metrics and alerts',
        license: 'Apache-2.0',
        images: ['prom/prometheus', 'prom/pushgateway'],
        icon: 'prometheus',
        href: 'https://prometheus.io',
      },
      {
        name: 'Jaeger',
        role: 'traces',
        license: 'Apache-2.0',
        images: ['jaegertracing/jaeger'],
        icon: 'jaeger',
        href: 'https://www.jaegertracing.io',
      },
      {
        name: 'Loki',
        role: 'logs',
        license: 'AGPL-3.0',
        images: ['grafana/loki'],
        href: 'https://grafana.com/oss/loki/',
      },
      {
        name: 'Grafana',
        role: 'dashboards',
        license: 'AGPL-3.0',
        images: ['grafana/grafana'],
        icon: 'grafana',
        href: 'https://grafana.com/oss/grafana/',
      },
      {
        name: 'GlitchTip',
        role: 'error tracking',
        license: 'MIT',
        images: ['glitchtip/glitchtip'],
        href: 'https://glitchtip.com',
        connect: 'Sentry, same SDKs, only the DSN changes',
      },
    ],
  },
  {
    group: 'Customers and growth',
    tools: [
      {
        name: 'Chatwoot',
        role: 'support inbox',
        license: 'MIT',
        images: ['chatwoot/chatwoot'],
        icon: 'chatwoot',
        href: 'https://www.chatwoot.com',
        connect: 'Chatwoot Cloud',
      },
      {
        name: 'Twenty',
        role: 'CRM',
        license: 'AGPL-3.0 + app exception',
        images: ['twentycrm/twenty'],
        icon: 'twenty',
        href: 'https://twenty.com',
        connect: 'Twenty Cloud',
      },
      {
        name: 'Cal.diy',
        role: 'booking',
        license: 'MIT',
        images: ['caldiy'],
        href: 'https://github.com/calcom/cal.diy',
        connect: 'Cal.com Cloud',
      },
      {
        name: 'Umami',
        role: 'web analytics',
        license: 'MIT',
        images: ['ghcr.io/umami-software/umami'],
        icon: 'umami',
        href: 'https://umami.is',
        connect: 'PostHog Cloud, Google Analytics 4 or Yandex Metrica',
      },
      {
        name: 'Postiz',
        role: 'social posting',
        license: 'AGPL-3.0',
        images: ['ghcr.io/gitroomhq/postiz-app'],
        icon: 'postiz',
        href: 'https://postiz.com',
      },
      {
        name: 'SerpBear',
        role: 'search rank tracking',
        license: 'MIT',
        images: ['towfiqi/serpbear'],
        href: 'https://github.com/towfiqi/serpbear',
      },
      {
        name: 'Plane',
        role: 'backlog: alerts, feedback and support requests become items',
        icon: 'plane',
        images: [],
        href: 'https://plane.so',
        connect: 'Plane Cloud or your own Plane, or GitHub Issues',
      },
      {
        name: 'Stripe',
        role: 'payments and subscriptions',
        icon: 'stripe',
        images: [],
        href: 'https://stripe.com',
        connect: 'Stripe, or contracts you invoice yourself',
      },
    ],
  },
  {
    group: 'Trust',
    tools: [
      {
        name: 'Vaultwarden',
        role: 'secrets vault',
        license: 'AGPL-3.0',
        images: ['vaultwarden/server'],
        icon: 'vaultwarden',
        href: 'https://github.com/dani-garcia/vaultwarden',
        connect: 'Bitwarden Cloud or a Bitwarden server you run',
      },
      {
        name: 'Mailpit',
        role: 'catches email in development',
        license: 'MIT',
        images: ['axllent/mailpit'],
        href: 'https://mailpit.axllent.org',
      },
    ],
  },
];

/** Images in docs/LICENSES.md that are runtimes, build steps or test fixtures, not tools to show. */
export const notShown = [
  'node',
  'python',
  'ghcr.io/astral-sh/uv',
  'saas-agent-starter-postgres',
  'saas-agent-starter-pgbackup',
  'stripe/stripe-mock',
  'ubuntu',
  'registry',
];
