/**
 * The guard app's store links and the `src` tag registry. One module, so the
 * /app page, the admin Guards page and every later surface read the same
 * values and a typo cannot put a different store URL in one place.
 *
 * THE ONE URL (owner decision, 2026-10-13): https://www.netraops.com/app is
 * the single target for email, QR codes, the in-app notice and the video.
 * Only the official store badges link straight to a store: the ones on /app
 * and Apple's on the homepage's "How it works" step 02 (owner decision,
 * 2026-10-14). Every text link goes to /app. check-site-links.ts pins this for
 * the public site.
 *
 * The store URLs are the ones the owner pasted from App Store Connect and
 * Play Console on 2026-10-13. Never derive or guess them. The App Store form
 * is deliberately region-less (no /us/) so it works in every storefront.
 *
 * `src` TAGS are placement labels, never data. The registry is frozen and
 * closed: an unknown value collapses to 'other' and is never echoed into a
 * store URL, a page or an analytics event, so a link edited by hand or by an
 * attacker cannot carry anything into the stores. NEVER put a guard id, name,
 * email, company or per-send id in a tag. check-store-links.ts enforces the
 * shape; it cannot enforce intent, so reviewers must.
 *
 * Pure module (no React, no Next imports): check-store-links.ts runs it
 * directly under ts-node, and the client enhancer imports the same functions.
 */

export const APP_PAGE_URL = 'https://www.netraops.com/app';
export const APP_STORE_URL = 'https://apps.apple.com/app/id6769264985';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.netraops.guard';

/**
 * Apple App Analytics campaign provider token (`pt`). EMPTY on purpose: Apple
 * only attributes a campaign link when `pt` and `ct` travel together, and `pt`
 * exists only after the owner creates the first campaign link in App Store
 * Connect. Until it is pasted here the App Store href is the bare URL of
 * record. Do not invent a value.
 */
export const APPLE_PROVIDER_TOKEN = '';

/**
 * Aggregation buckets. Apple's App Analytics hides a campaign until at least
 * 5 users, and the iPhone fleet is ~24 guards, so per-placement rows would
 * mostly be blank: the stores see the bucket, our own /app page view sees the
 * full tag. Apple's `ct` allows 30 characters of letters, digits and hyphen,
 * so bucket names stay single lowercase words.
 */
export type Bucket =
  | 'email'
  | 'admin'
  | 'site'
  | 'video'
  | 'inapp'
  | 'migrate'
  | 'direct'
  | 'qa'
  | 'other';

/**
 * The frozen registry: ONE entry per placement, lowercase [a-z0-9_], 2-24
 * characters. Tags used inside QR codes are short aliases (admin, desktop,
 * video, print, slides: 9 characters or fewer) so the code stays a 29x29
 * version-3 symbol. Add a placement here, in the same PR that adds the link.
 */
export const SRC_REGISTRY = {
  // email
  welcome_email: 'email',
  admin_welcome: 'email',
  // admin web
  admin_copy: 'admin',
  admin_banner: 'admin',
  admin: 'admin', // QR payload alias for the admin Guard app panel
  // public site
  app_page: 'site', // the /app page's own default when no src is given
  desktop: 'site', // QR payload alias for the desktop view of /app
  home_step2: 'site',
  site_nav: 'site',
  site_footer: 'site',
  site_faq: 'site',
  site_support: 'site',
  site_deletion: 'site',
  site_demo: 'site',
  login_portal: 'site',
  login_admin: 'site',
  // video
  video: 'video', // QR payload alias for a video end card
  demo_video: 'video',
  demo_page: 'video',
  // in the guard app
  inapp_notice: 'inapp',
  inapp_update: 'inapp',
  // moving existing TestFlight / APK guards to the store builds
  migrate_admin: 'migrate',
  migrate_msg: 'migrate',
  migrate_app: 'migrate',
  migrate_email: 'migrate',
  // typed or pasted by a person, no placement of ours
  direct: 'direct',
  email_sig: 'direct',
  support_reply: 'direct',
  linkedin: 'direct',
  print: 'direct',
  slides: 'direct',
  // testing
  qa_test: 'qa',
  // the collapse target for anything not listed above
  other: 'other',
} as const satisfies Record<string, Bucket>;

export type SrcTag = keyof typeof SRC_REGISTRY;

/** Shape every registry key must have; checked by check-store-links.ts. */
export const TAG_PATTERN = /^[a-z0-9_]{2,24}$/;

/**
 * Collapse any inbound `src` to a registry tag. Missing or empty is 'direct'
 * (someone typed the URL). Anything else not in the registry is 'other'. The
 * input is never returned, so it cannot reach a store URL or an event.
 */
export function normalizeSrc(raw: unknown): SrcTag {
  if (raw === null || raw === undefined) return 'direct';
  if (typeof raw !== 'string') return 'other';
  const t = raw.trim().toLowerCase();
  if (t === '') return 'direct';
  if (t.length <= 24 && TAG_PATTERN.test(t) && Object.prototype.hasOwnProperty.call(SRC_REGISTRY, t)) {
    return t as SrcTag;
  }
  return 'other';
}

/** App Store href for a placement: the bare URL of record until Apple's `pt` exists. */
export function appStoreHref(tag: SrcTag): string {
  if (!APPLE_PROVIDER_TOKEN) return APP_STORE_URL;
  return `${APP_STORE_URL}?pt=${encodeURIComponent(APPLE_PROVIDER_TOKEN)}&ct=${SRC_REGISTRY[tag]}&mt=8`;
}

/**
 * Google Play href for a placement. Play Console's acquisition reports read
 * utm_source and utm_campaign from the install referrer; the placement rides
 * in utm_medium. The whole referrer value is percent-encoded once, as one
 * parameter.
 */
export function playHref(tag: SrcTag): string {
  const referrer = `utm_source=netraops&utm_medium=${tag}&utm_campaign=${SRC_REGISTRY[tag]}`;
  return `${PLAY_STORE_URL}&referrer=${encodeURIComponent(referrer)}`;
}

/** The ONE URL, tagged for a placement. Use this everywhere except the /app badges. */
export function appLink(tag: SrcTag): string {
  return `${APP_PAGE_URL}?src=${tag}`;
}

export type Platform = 'ios' | 'android' | 'other';

/**
 * Anything that is not a person on a phone browser. Matched by SUBSTRING, case
 * insensitive, because Storebot-Google survives only on 'bot' and
 * Google-InspectionTool only on 'compatible;'. Crawlers and link previewers
 * render this page too (Googlebot Smartphone is an Android UA, and Google's
 * renderer runs JavaScript), so they must see BOTH badges. Fire tablets
 * (Silk, KF*) and Huawei browsers have no Google Play, so they also get both
 * badges and the "ask your admin" line.
 */
const NOT_A_PHONE_BROWSER =
  /bot|crawl|spider|slurp|preview|lighthouse|googleother|inspectiontool|storebot|googlemessages|whatsapp|facebookexternalhit|facebot|slackbot|linkedinbot|twitterbot|applebot|discordbot|skypeuripreview|cfnetwork|\+http|compatible;|silk|huaweibrowser|\bKF[A-Z]{2,5}\b/i;

/**
 * Which store a phone visitor wants. Used ONLY to hide the other platform's
 * badge on a confident phone; every other case (desktop, iPad in desktop
 * mode, Android tablet, bots, empty or oversized UA) shows both. There is no
 * redirect anywhere: /app is a static page.
 */
export function detectPlatform(ua: unknown): Platform {
  if (typeof ua !== 'string' || ua === '' || ua.length > 512) return 'other';
  if (NOT_A_PHONE_BROWSER.test(ua)) return 'other';
  if (/\b(iPhone|iPod)\b/.test(ua)) return 'ios';
  if (/Android/.test(ua) && /\bMobile\b/.test(ua)) return 'android';
  return 'other';
}

/**
 * Official badge artwork, once it is in the repo. Each store's artwork is
 * downloaded by the owner from the store's own tool (Apple Marketing Tools,
 * Google Partner Marketing Hub) under that store's terms, and committed
 * UNALTERED under public/badges/. Until an entry exists the page shows a
 * plain text link, never a lookalike badge. width/height are the artwork's
 * own pixel dimensions rounded to whole numbers (HTML attributes), used only to
 * reserve the aspect ratio before the file loads; the file's own size wins.
 *
 * APPLE ships, GOOGLE does not yet (owner decision, 2026-10-13 evening): Apple's
 * official badge sits left and Google Play is a text link of the SAME height on
 * the right. When Google's file lands, add it here and the text link becomes
 * the badge; nothing else changes. Each entry carries the sha256 of the file as
 * supplied: scripts/check-store-links.ts compares it with the file in the repo,
 * and scripts/check-app-page.ts with the bytes the deployed site serves, so a
 * re-save, an "optimised" copy or a CDN transform fails loudly.
 */
export interface BadgeArtwork {
  src: string;
  width: number;
  height: number;
  /** sha256 (hex) of the file exactly as the store supplied it. */
  sha256: string;
}
export const STORE_ARTWORK: { apple?: BadgeArtwork; google?: BadgeArtwork } = {
  // "Download on the App Store", black, US-UK, as supplied (119.66407 x 40).
  apple: {
    src: '/badges/Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg',
    width: 120,
    height: 40,
    sha256: 'a26fc5b38380272c92e9019a2eb8b45542a66814b3e2b203772db8904b9fb99f',
  },
};

/**
 * ONE height for every store link on /app, badge and text link alike, so the
 * row never has a tall item and a short one. Apple's floor is 40 px on screen;
 * 56 clears it and the 44 px tap target.
 */
export const BADGE_HEIGHT_PX = 56;
/** Apple: the clear space around its badge is a quarter of the badge's height, with nothing inside it. */
export const APPLE_CLEAR_SPACE_PX = BADGE_HEIGHT_PX / 4;
