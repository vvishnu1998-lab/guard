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
};

module.exports = nextConfig;
