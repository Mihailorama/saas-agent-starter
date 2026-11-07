// Lighthouse CI (Apache-2.0) for the app (apps/web), run on PRs by .github/workflows/ui.yml and
// locally with `pnpm --filter web lhci` after `pnpm --filter web build` with the API running
// (the preview server proxies /api like nginx does). Same style as the marketing site's config.
// Public pages only: the signed-in pages are covered by axe in the e2e suite (e2e/a11y.spec.ts).
// Thresholds: lower them only with a reason in the PR.
const port = process.env.LHCI_PORT || '4173';
const base = `http://localhost:${port}`;

module.exports = {
  ci: {
    collect: {
      startServerCommand: `pnpm exec vite preview --port ${port} --strictPort`,
      startServerReadyPattern: 'localhost',
      url: ['/sign-in', '/ai-transparency'].map((path) => base + path),
      numberOfRuns: 1,
      settings: { preset: 'desktop' },
    },
    assert: {
      assertions: {
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'categories:best-practices': ['error', { minScore: 0.95 }],
        'categories:performance': ['warn', { minScore: 0.8 }],
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci/reports' },
  },
};
