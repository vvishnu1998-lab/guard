import { BADGE_HEIGHT_PX, STORE_ARTWORK, appLink, appStoreHref } from '../../lib/storeLinks';

// Homepage "How it works", step 02 (Guards Clock In): where a guard (or the
// admin who is about to add one) goes to get the app. Server component, so the
// anchors are in the HTML every visitor and crawler receives; no script.
//
// Apple's official badge on a light tile (its artwork is black and must not be
// recoloured), linking STRAIGHT to the App Store listing as it does on /app. The
// tile's padding (p-4 = 16 px) is larger than Apple's clear space (a quarter of
// the badge height = 14 px), so nothing sits inside the clear space; the tile IS
// the anchor, so the site-wide focus ring is drawn outside it on the navy page. Google has
// no badge file yet, so Android is a plain text link to /app (the ONE URL),
// which then shows the right store; it is deliberately not styled as a badge.
// When STORE_ARTWORK.apple is absent the tile is skipped and only the text link
// remains: never a lookalike badge.
export default function Step2AppLinks() {
  const apple = STORE_ARTWORK.apple;
  return (
    <div className="mt-6 flex flex-col items-center gap-2">
      {apple && (
        <a
          data-step2="apple"
          href={appStoreHref('home_step2')}
          className="inline-flex rounded-xl bg-[#F5F3EE] p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- unaltered store artwork, served as-is */}
          <img src={apple.src} alt="Download on the App Store" width={apple.width} height={apple.height} style={{ height: BADGE_HEIGHT_PX, width: 'auto' }} />
        </a>
      )}
      <a
        data-step2="app"
        href={appLink('home_step2')}
        className="inline-flex min-h-[44px] items-center text-sm text-[#C9A84C] underline underline-offset-2 hover:text-[#D4B560] transition-colors"
        style={{ fontFamily: 'var(--font-dm-sans), sans-serif' }}
      >
        On Android? Get the app
      </a>
    </div>
  );
}
