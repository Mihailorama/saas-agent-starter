// Lighthouse CI (Apache-2.0) budgets for the marketing site, run on PRs by .github/workflows/site.yml
// and locally with `pnpm --filter site lhci` after `pnpm --filter site build`.
// Thresholds are the release bar from docs/marketing.md; lower them only with a reason in the PR.
// Lighthouse CI serves dist/ itself on a free port; the build's canonical URLs (SITE_URL) only
// need the same host, so build with SITE_URL=http://localhost:4321.
const median = (minScore) => ['error', { minScore, aggregationMethod: 'median' }];

module.exports = {
  ci: {
    collect: {
      staticDistDir: './dist',
      url: ['/', '/blog/', '/blog/hello-world/'].map((path) => `http://localhost${path}`),
      numberOfRuns: 3,
    },
    assert: {
      assertions: {
        'categories:performance': median(0.9),
        'categories:accessibility': median(0.95),
        'categories:best-practices': median(0.95),
        'categories:seo': median(0.95),
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci/reports' },
  },
};
