// The services in the box, for the landing's "What is in the box" (apps/site/src/pages/index.astro).
// Licenses and images come from docs/LICENSES.md; scripts/site-stack.test.mjs fails when an image
// there is missing here or a license differs, so the page cannot drift from the real stack.
// `icon` is a Simple Icons slug (CC0-1.0 data; the marks stay their owners' trademarks); without
// one the page shows the name's initial.
export type Tool = {
  name: string;
  role: string;
  license: string;
  images: string[];
  icon?: string;
  href: string;
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
      },
      {
        name: 'Twenty',
        role: 'CRM',
        license: 'AGPL-3.0 + app exception',
        images: ['twentycrm/twenty'],
        icon: 'twenty',
        href: 'https://twenty.com',
      },
      {
        name: 'Cal.diy',
        role: 'booking',
        license: 'MIT',
        images: ['caldiy'],
        href: 'https://github.com/calcom/cal.diy',
      },
      {
        name: 'Umami',
        role: 'web analytics',
        license: 'MIT',
        images: ['ghcr.io/umami-software/umami'],
        icon: 'umami',
        href: 'https://umami.is',
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
