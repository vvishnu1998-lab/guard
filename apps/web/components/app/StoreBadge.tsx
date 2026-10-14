import { APP_STORE_URL, BADGE_HEIGHT_PX, PLAY_STORE_URL, STORE_ARTWORK, appStoreHref, playHref } from '../../lib/storeLinks';

// One store link on /app. Server component: the anchors and their FIXED
// page-level tag are in the HTML that every visitor, crawler and link
// previewer receives. AppLinksEnhancer (client) later re-tags the hrefs from
// ?src= and hides the other platform's link on a confident phone.
//
// The badge image links STRAIGHT to its own store listing (never to /app):
// both stores' own generators only ever produced direct links, and Google's
// last published rule said so. See lib/storeLinks.ts.
//
// NEVER draw a lookalike badge. Both stores forbid altering their artwork,
// and Apple forbids building your own. When the official artwork is not in
// the repo yet (STORE_ARTWORK) this renders a plain text link instead. Today
// that is Google Play; Apple's badge ships. Both are exactly BADGE_HEIGHT_PX tall,
// so the row is one height whichever of the two is a badge.

const COPY = {
  apple: {
    href: appStoreHref('app_page'),
    base: APP_STORE_URL,
    alt: 'Download on the App Store',
    text: 'Available on the App Store',
  },
  google: {
    href: playHref('app_page'),
    base: PLAY_STORE_URL,
    alt: 'Get it on Google Play',
    text: 'Available on Google Play',
  },
} as const;

export default function StoreBadge({ store }: { store: 'apple' | 'google' }) {
  const c = COPY[store];
  const art = store === 'apple' ? STORE_ARTWORK.apple : STORE_ARTWORK.google;
  // group-data-[platform=...] hides the OTHER store on a confident phone. The
  // group is <main id="store-links"> in app/app/page.tsx. On
  // every other visitor (desktop, iPad, bots, no-JS) both stay visible.
  const hideWhen = store === 'apple' ? 'group-data-[platform=android]:hidden' : 'group-data-[platform=ios]:hidden';

  return (
    <a
      data-store={store}
      href={c.href}
      // The site-wide focus ring (cyan, tuned for the navy page) is about 1.6:1 on this cream
      // tile; a navy ring is 16.5:1. The `!` is needed because `.mkt a:focus-visible` is more specific.
      className={`inline-flex items-center justify-center rounded-lg focus-visible:!outline-[#0B1526] ${hideWhen}`}
      style={{ minHeight: BADGE_HEIGHT_PX }}
    >
      {art ? (
        // eslint-disable-next-line @next/next/no-img-element -- unaltered store artwork, served as-is
        <img src={art.src} alt={c.alt} width={art.width} height={art.height} style={{ height: BADGE_HEIGHT_PX, width: 'auto' }} />
      ) : (
        <span className="inline-flex items-center justify-center whitespace-nowrap rounded-lg bg-[#0B1526] px-4 sm:px-6 text-base font-semibold text-white" style={{ minHeight: BADGE_HEIGHT_PX }}>
          {c.text}
        </span>
      )}
    </a>
  );
}
