const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '*.s3.amazonaws.com' }],
  },
  // Three portals share one Next.js app:
  // /admin/* = Star admin dashboard
  // /client/* = Client read-only portal
  // /vishnu/* = Vishnu super admin panel

  // Skip static generation of error pages (avoids React duplicate instance
  // crash in monorepo local builds — no effect on Vercel)
  experimental: {
    missingSuspenseWithCSRBailout: false,
    // Next 14.2 defaults this to false, and without it instrumentation.ts is
    // never loaded — the server and edge runtimes would report nothing.
    // Stable (no flag needed) from Next 15.
    instrumentationHook: true,
  },

  // Route renames (task #5, 2026-07-08). Permanent 301 so:
  //   - breach-alert emails already in admin inboxes deep-link to the
  //     right page even though we renamed the route,
  //   - admin bookmarks for /admin/reports continue to work,
  //   - external references to /privacy-policy (if any) land on /privacy.
  // Next.js preserves the query string on redirect, so
  //   /admin/live-map?breach=<id> → /admin/live-status?breach=<id> works.
  async redirects() {
    return [
      {
        source: '/admin/live-map',
        destination: '/admin/live-status',
        permanent: true,
      },
      {
        source: '/admin/reports',
        destination: '/admin/activity',
        permanent: true,
      },
      {
        source: '/admin/reports/:path*',
        destination: '/admin/activity/:path*',
        permanent: true,
      },
      {
        source: '/privacy-policy',
        destination: '/privacy',
        permanent: true,
      },
    ];
  },
};

/**
 * Sentry build-time wiring. Option names verified against the installed
 * @sentry/nextjs 10.69.0 type definitions, not carried over from older docs:
 *   - `hideSourceMaps` no longer exists; the current equivalent is
 *     `sourcemaps.deleteSourcemapsAfterUpload` (default true, set explicitly
 *     here so the intent is on the page): maps are uploaded to Sentry for
 *     readable stack traces, then removed from the build output so they are
 *     never served to a browser.
 *   - `disableLogger` is deprecated in favour of
 *     `webpack.treeshake.removeDebugLogging`.
 *
 * `authToken` is intentionally absent — the plugin reads SENTRY_AUTH_TOKEN
 * from the environment, which is set in Vercel Production only. Local builds
 * skip the upload rather than failing.
 */
module.exports = withSentryConfig(nextConfig, {
  org: 'netraopscom',
  project: 'netraops-web',

  // Upload client source maps for the whole build, including framework
  // chunks, so App Router stack traces resolve.
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },

  // Ad blockers block ingest.sentry.io outright, and admin users
  // disproportionately run them — without tunnelling, errors from exactly
  // the users most likely to hit edge cases are lost silently. `true`
  // auto-generates a randomised, ad-blocker-resistant route per build,
  // which is stronger than a fixed well-known path like /monitoring.
  // Not covered by middleware.ts's matcher, so it is never auth-gated.
  tunnelRoute: true,

  webpack: {
    treeshake: {
      // Strip SDK debug logging from production bundles.
      removeDebugLogging: true,
      // Drop the tracing/performance code path entirely. These portals are
      // used on phones, and the tracing bundle cost most of the SDK's weight
      // for 5%-sampled data nobody consumes. Error reporting is the point of
      // this integration and is unaffected.
      removeTracing: true,
    },
  },
});
