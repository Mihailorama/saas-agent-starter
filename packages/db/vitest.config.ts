import { defineConfig } from 'vitest/config';

// Real env > repo .env > .env.example (loadEnvFile never overrides existing vars).
for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
