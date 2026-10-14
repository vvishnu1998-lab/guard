import type { Metadata, ResolvingMetadata } from 'next';
import Link from 'next/link';
import LogoImage from '../../components/marketing/LogoImage';
import StoreBadge from '../../components/app/StoreBadge';
import AppLinksEnhancer from '../../components/app/AppLinksEnhancer';
import { APP_PAGE_URL, APP_STORE_URL, PLAY_STORE_URL } from '../../lib/storeLinks';

// https://www.netraops.com/app: THE one URL for getting the guard app. Email,
// QR codes, the in-app notice, the video and admin hand-offs all point here
// (owner decision, 2026-10-13). Only the two official badges below link
// straight to a store.
//
// STATIC ON PURPOSE. Identical HTML for every visitor and every user agent:
// no searchParams prop, no headers()/cookies(), no redirect, no middleware
// branch. `force-static` makes the build fail if a dynamic API ever creeps in.
// Why it matters: Googlebot Smartphone is an Android UA, Google's renderer runs
// JavaScript, and Slack/iMessage/WhatsApp previewers fetch pasted links; a
// per-UA response would show them something other than the page people get.
// A tap-to-open page also cannot hit Safari's open-in-App-Store prompt or an
// in-app browser that refuses store hand-offs. The ?src= tag is read only in
// the client enhancer, for attribution, and never changes content or metadata.

export const dynamic = 'force-static';

const TITLE = 'Get the guard app';
const DESCRIPTION =
  'Install the NetraOps guard app on your iPhone or Android phone. Your company admin creates your account.';

// A page-level openGraph / twitter block REPLACES the inherited one, share
// image included, so the parent's images are carried over explicitly (same
// pattern as app/customers/starnet/page.tsx). Without an explicit url the
// unfurl would name the homepage.
export async function generateMetadata(_props: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  const inherited = await parent;
  return {
    // Root template renders this as `Get the guard app · NetraOps`.
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: '/app' },
    openGraph: {
      type: 'website',
      siteName: 'NetraOps',
      url: APP_PAGE_URL,
      title: TITLE,
      description: DESCRIPTION,
      images: inherited.openGraph?.images,
    },
    twitter: {
      card: 'summary_large_image',
      title: TITLE,
      description: DESCRIPTION,
      images: inherited.twitter?.images,
    },
  };
}

// Honest, minimal structured data. Google's software-app rich result needs a
// rating or review, which NetraOps cannot truthfully supply, so there is no
// aggregateRating, review or offers: the block only says what this page is and
// where installs happen. `<` is escaped so the JSON can never close the tag.
const JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'MobileApplication',
  name: 'NetraOps',
  alternateName: 'Netraops',
  url: APP_PAGE_URL,
  description: DESCRIPTION,
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'iOS, Android',
  installUrl: [APP_STORE_URL, PLAY_STORE_URL],
  sameAs: [APP_STORE_URL, PLAY_STORE_URL],
  publisher: { '@type': 'Organization', name: 'Calvern LLC' },
}).replace(/</g, '\\u003c');

const BODY_FONT = { fontFamily: 'var(--font-dm-sans), sans-serif' };

export default function AppPage() {
  return (
    <div className="mkt min-h-screen bg-[#0B1526] text-white overflow-x-hidden" style={BODY_FONT}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-white/[0.05]">
        <div className="max-w-3xl mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <LogoImage size={32} className="object-contain" />
            <span className="font-display uppercase text-xl font-bold tracking-[0.08em] text-white">NetraOps</span>
          </Link>
          <Link href="/" className="text-white/50 hover:text-white text-xs tracking-[0.2em] transition-colors">
            HOME
          </Link>
        </div>
      </header>

      {/* id/group/data-platform live on <main> so the platform marker reaches the
          badges AND the help lines below that name a store: the client enhancer
          sets data-platform from the user agent, CSS hides the other store's
          wording. Server HTML is identical for everyone (data-platform="other"). */}
      <main id="store-links" data-platform="other" className="group max-w-3xl mx-auto px-6 pt-14 pb-20">
        <p className="text-[#C9A84C] text-xs tracking-[0.35em] font-semibold mb-4">FOR SECURITY GUARDS</p>
        <h1 className="font-display uppercase text-4xl md:text-6xl font-bold tracking-[0.02em] text-white mb-5">
          Get the NetraOps guard app
        </h1>
        <p className="text-white/70 text-lg max-w-xl mb-10">
          Install the app on your phone, then sign in with the email and temporary password your company admin gave you.
          The app asks you to choose a new password the first time.
        </p>

        {/* ── STORE BADGES ─────────────────────────────────────────────────────
            Light tile: Apple's badge is black with a grey border and must not
            be recoloured; a light tile gives it contrast (Apple's guidelines
            name no background), and its quarter-height clear space stays
            empty: the tile's padding and gap are both larger than a quarter
            of the badge height. From the sm breakpoint (640 px) Apple's
            official badge is on the left and Google Play is a text link of the
            SAME height on the right; below it they stack, Apple on top. Google's
            artwork replaces the text link when its file lands. With no
            JavaScript both show. */}
        <div
          className="rounded-2xl bg-[#F5F3EE] p-6 sm:p-8 flex flex-col sm:flex-row items-center justify-center gap-5 sm:gap-8"
          style={{ minHeight: 120 }}
        >
          <StoreBadge store="apple" />
          <StoreBadge store="google" />
        </div>
        <p className="mt-3 text-white/50 text-sm">Tap to open the store on your phone.</p>
        <AppLinksEnhancer />

        {/* ── DESKTOP → PHONE ─────────────────────────────────────────────────
            Hidden where the pointer is coarse (a phone cannot scan its own
            screen). Shown by default, so no JavaScript is needed. */}
        <section className="[@media(pointer:coarse)]:hidden mt-12 flex flex-col sm:flex-row items-center gap-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
          <div className="shrink-0 rounded-xl overflow-hidden bg-white" style={{ width: 222, height: 222 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a static, committed SVG */}
            <img
              src="/qr/app-desktop.svg"
              alt="QR code: opens netraops.com/app to get the NetraOps guard app"
              width={222}
              height={222}
            />
          </div>
          <div>
            <h2 className="font-display uppercase text-2xl font-bold tracking-[0.04em] text-white mb-2">On a computer?</h2>
            <p className="text-white/70">
              Point your phone&apos;s camera at this code, or type{' '}
              <span className="text-[#C9A84C] font-semibold">netraops.com/app</span> into your phone&apos;s browser.
            </p>
          </div>
        </section>

        {/* ── HELP ─────────────────────────────────────────────────────────── */}
        <section className="mt-12 space-y-4 text-white/70">
          <p>
            <span className="text-white font-semibold">Can&apos;t find it?</span> Search for NetraOps by Calvern LLC in{' '}
            <span className="group-data-[platform=android]:hidden">the App Store</span>
            <span className="group-data-[platform=ios]:hidden group-data-[platform=android]:hidden"> or </span>
            <span className="group-data-[platform=ios]:hidden">Google Play</span>.
          </p>
          <p className="group-data-[platform=ios]:hidden">
            <span className="text-white font-semibold">No Google Play on your phone, or it won&apos;t install?</span> Ask your
            company admin.
          </p>
          <p>
            <span className="text-white font-semibold">Admin or client?</span> You sign in on the web:{' '}
            <Link href="/portal" className="text-[#C9A84C] hover:text-[#D4B560] underline underline-offset-2">
              log in
            </Link>
            .
          </p>
        </section>
      </main>

      {/* ── FOOTER + CREDIT LINES ──────────────────────────────────────────────
          Credit lines go where legal information lives, once per site/page and
          only for the marks used. Apple's wording is from its Marketing
          Resources and Identity Guidelines (counsel may confirm). Google's is
          from its badge guidance as last published and is UNVERIFIED against
          today's Partner Marketing Hub (the page read on 2026-10-13 did not
          carry the legal line); re-read it when Google's badge file lands.
          Google Play is a TEXT link today, so its "logo" half applies once
          the badge does. */}
      <footer className="border-t border-white/[0.05] py-10 px-6">
        <div className="max-w-3xl mx-auto space-y-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="text-white/50 text-xs tracking-[0.2em]">© 2026 NETRAOPS</span>
            <Link href="/privacy" className="text-white/50 hover:text-white text-xs tracking-widest transition-colors">PRIVACY</Link>
            <Link href="/terms" className="text-white/50 hover:text-white text-xs tracking-widest transition-colors">TERMS</Link>
            <Link href="/support" className="text-white/50 hover:text-white text-xs tracking-widest transition-colors">SUPPORT</Link>
          </div>
          <p className="text-white/50 text-[11px] leading-relaxed">
            Apple and the Apple logo are trademarks of Apple Inc., registered in the U.S. and other countries and regions.
            App Store is a service mark of Apple Inc., registered in the U.S. and other countries and regions. Google Play and
            the Google Play logo are trademarks of Google LLC.
          </p>
        </div>
      </footer>
    </div>
  );
}
