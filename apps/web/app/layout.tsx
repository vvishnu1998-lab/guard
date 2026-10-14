import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { FONT_VARIABLES } from './fonts';
import './globals.css';

const SITE_DESCRIPTION =
  'Real-time security guard management: GPS patrol tracking, geofence compliance, photo-verified clock-ins, and automated shift reports for security companies.';

export const metadata: Metadata = {
  metadataBase: new URL('https://www.netraops.com'),
  title: {
    default: 'NetraOps — Security Guard Management Software',
    template: '%s · NetraOps',
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: 'NetraOps',
    url: 'https://www.netraops.com',
    title: 'NetraOps — Security Guard Management Software',
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'NetraOps — Security Guard Management Software',
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ ...FONT_VARIABLES, scrollBehavior: 'smooth' } as CSSProperties}>
      <body style={{ fontFamily: 'var(--font-inter)', fontStyle: 'normal' }}>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
