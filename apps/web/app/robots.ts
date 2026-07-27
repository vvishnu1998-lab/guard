import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/portal', '/admin', '/client', '/vishnu', '/api'],
    },
    sitemap: 'https://www.netraops.com/sitemap.xml',
  };
}
