import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

const api = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Same-origin /api in dev, like nginx does in the container: cookies just work.
  server: {
    proxy: { '/api': api, '/mcp': api },
    // Test reports and screenshots are written while the dev server runs; do not reload on them.
    watch: { ignored: ['**/.visual/**', '**/.lighthouseci/**', '**/test-results/**'] },
  },
});
