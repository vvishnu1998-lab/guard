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

module.exports = nextConfig;
