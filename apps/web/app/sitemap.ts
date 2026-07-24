import type { MetadataRoute } from 'next';

// Marketing pages only — portal routes (/admin, /client, /vishnu, /portal)
// are auth-gated and deliberately excluded.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://www.netraops.com';
  return [
    { url: `${base}/`, changeFrequency: 'monthly', priority: 1 },
    { url: `${base}/support`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
