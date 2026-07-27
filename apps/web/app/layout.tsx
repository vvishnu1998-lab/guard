import type { Metadata } from 'next';
import { Inter, Bebas_Neue, DM_Sans } from 'next/font/google';
import { Analytics } from '@vercel/analytics/react';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
  variable: '--font-inter',
  display: 'swap',
});

const bebasNeue = Bebas_Neue({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-bebas',
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dm-sans',
  display: 'swap',
});

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
    <html lang="en" className={`${inter.variable} ${bebasNeue.variable} ${dmSans.variable}`} style={{ scrollBehavior: 'smooth' }}>
      <body className={inter.className}>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
