#!/usr/bin/env ts-node
/**
 * Prove the contracts the guard-app links rest on, by running them.
 *
 * 1. THE STORE URLS ARE THE OWNER'S, BYTE FOR BYTE. They were pasted from App
 *    Store Connect and Play Console. A silent edit (a /us/ prefix, a dropped
 *    id) would send every email, QR and notice to the wrong place, and no
 *    server error would ever say so.
 *
 * 2. THE `src` REGISTRY IS CLOSED. An unknown or hostile value must collapse to
 *    'other' and must never appear in a store URL: the tag is public, and the
 *    stores' consoles and our analytics would otherwise show whatever anyone
 *    typed. A check that only fed it friendly values would pass on a registry
 *    that echoed its input, so the hostile cases are the point.
 *
 * 3. THE PLATFORM CLASSIFIER ONLY SAYS 'ios' OR 'android' FOR A PERSON ON A
 *    PHONE. Googlebot Smartphone carries an Android UA and Google renders the
 *    page with JavaScript; if it were classed 'android' the rendered page
 *    would lose the App Store badge. Everything unsure must say 'other' so the
 *    page shows both badges.
 *
 * Run: npm run check:store-links (from apps/web). Not postinstall.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  APP_PAGE_URL,
  APP_STORE_URL,
  APPLE_CLEAR_SPACE_PX,
  APPLE_PROVIDER_TOKEN,
  BADGE_HEIGHT_PX,
  PLAY_STORE_URL,
  SRC_REGISTRY,
  STORE_ARTWORK,
  TAG_PATTERN,
  appLink,
  appStoreHref,
  detectPlatform,
  normalizeSrc,
  playHref,
} from '../lib/storeLinks';
import type { Bucket, SrcTag } from '../lib/storeLinks';

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL  ${m}`); };
const eq = (label: string, got: unknown, want: unknown) => {
  if (got !== want) fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// ── 1. the URLs of record ──────────────────────────────────────────────────
console.log('[check-store-links] URLs of record');
eq('APP_PAGE_URL', APP_PAGE_URL, 'https://www.netraops.com/app');
eq('APP_STORE_URL', APP_STORE_URL, 'https://apps.apple.com/app/id6769264985');
eq('PLAY_STORE_URL', PLAY_STORE_URL, 'https://play.google.com/store/apps/details?id=com.netraops.guard');
if (/\/[a-z]{2}\/app\//.test(APP_STORE_URL)) fail('APP_STORE_URL must be region-less (no /us/)');
if (APP_PAGE_URL.endsWith('/')) fail('APP_PAGE_URL must have no trailing slash (a slash adds a redirect hop)');
if (!APP_PAGE_URL.startsWith('https://www.')) fail('APP_PAGE_URL must be the www host, never the apex or app.');

// ── 2. the registry ────────────────────────────────────────────────────────
console.log('[check-store-links] registry');
const BUCKETS: Bucket[] = ['email', 'admin', 'site', 'video', 'inapp', 'migrate', 'direct', 'qa', 'other'];
const tags = Object.keys(SRC_REGISTRY) as SrcTag[];
console.log(`  ${tags.length} tags in ${new Set(Object.values(SRC_REGISTRY)).size} buckets`);
for (const t of tags) {
  if (!TAG_PATTERN.test(t)) fail(`tag '${t}' breaks ${TAG_PATTERN}`);
  const b = SRC_REGISTRY[t];
  if (!BUCKETS.includes(b)) fail(`tag '${t}' maps to unknown bucket '${b}'`);
  // Apple ct: 30 chars max, letters / digits / hyphen. Buckets are single words.
  if (!/^[a-z0-9-]{1,30}$/.test(b)) fail(`bucket '${b}' is not a valid Apple ct`);
  eq(`normalizeSrc('${t}')`, normalizeSrc(t), t);
}
// QR payload aliases must stay short enough for a version-3 symbol (33 + tag <= 42 at ECC M).
for (const alias of ['admin', 'desktop', 'video', 'print', 'slides'] as SrcTag[]) {
  if (!(alias in SRC_REGISTRY)) fail(`QR alias '${alias}' missing from the registry`);
  if (alias.length > 9) fail(`QR alias '${alias}' is longer than 9 characters`);
}
for (const bucket of BUCKETS) {
  if (!Object.values(SRC_REGISTRY).includes(bucket)) fail(`bucket '${bucket}' has no tag`);
}

// ── 2b. hostile input never reaches a URL ──────────────────────────────────
console.log('[check-store-links] hostile and odd src values');
const HOSTILE: unknown[] = [
  '<script>alert(1)</script>',
  'javascript:alert(1)',
  'https://evil.example/',
  '../../etc/passwd',
  '"; DROP TABLE guards;--',
  'guard@example.com',
  'GRD0024',
  '__proto__',
  'constructor',
  'toString',
  'x'.repeat(5000),
  'welcome_email&ct=hack',
  'welcome_email%26ct%3Dhack',
  42,
  {},
  [],
  true,
];
for (const h of HOSTILE) {
  const t = normalizeSrc(h);
  eq(`normalizeSrc(${JSON.stringify(h)?.slice(0, 40)})`, t, 'other');
  const urls = [appStoreHref(t), playHref(t), appLink(t)];
  for (const u of urls) {
    if (typeof h === 'string' && h.length > 0 && u.includes(h)) fail(`hostile value leaked into ${u.slice(0, 80)}`);
    if (/<|>|"|\s/.test(u)) fail(`URL contains an unsafe character: ${u}`);
  }
}
eq('normalizeSrc(undefined)', normalizeSrc(undefined), 'direct');
eq('normalizeSrc(null)', normalizeSrc(null), 'direct');
eq("normalizeSrc('')", normalizeSrc(''), 'direct');
eq("normalizeSrc('   ')", normalizeSrc('   '), 'direct');
eq("normalizeSrc(' Welcome_Email ')", normalizeSrc(' Welcome_Email '), 'welcome_email');

// ── 2c. the hrefs ──────────────────────────────────────────────────────────
console.log('[check-store-links] hrefs');
if (APPLE_PROVIDER_TOKEN === '') {
  // No provider token yet: the bare URL of record, never a half-formed campaign link.
  eq('appStoreHref without a provider token', appStoreHref('welcome_email'), APP_STORE_URL);
} else {
  const u = new URL(appStoreHref('welcome_email'));
  eq('Apple pt', u.searchParams.get('pt'), APPLE_PROVIDER_TOKEN);
  eq('Apple ct', u.searchParams.get('ct'), 'email');
}
{
  const u = new URL(playHref('welcome_email'));
  eq('Play id survives', u.searchParams.get('id'), 'com.netraops.guard');
  const ref = u.searchParams.get('referrer') ?? '';
  const inner = new URLSearchParams(ref);
  eq('Play referrer utm_source', inner.get('utm_source'), 'netraops');
  eq('Play referrer utm_medium', inner.get('utm_medium'), 'welcome_email');
  eq('Play referrer utm_campaign', inner.get('utm_campaign'), 'email');
  // The referrer is ONE parameter: its own & and = must be percent-encoded in the href.
  if (/referrer=[^&]*[&=]/.test(playHref('welcome_email').split('referrer=')[1] ? 'referrer=' + playHref('welcome_email').split('referrer=')[1] : '')) {
    fail('Play referrer value contains a raw & or =');
  }
  if (playHref('welcome_email').split('&').length !== 2) fail('Play href must carry exactly id and referrer');
}
eq('appLink', appLink('welcome_email'), 'https://www.netraops.com/app?src=welcome_email');
eq('appLink qr alias', appLink('desktop'), 'https://www.netraops.com/app?src=desktop');

// ── 3. the platform classifier ─────────────────────────────────────────────
console.log('[check-store-links] platform classifier');
const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/137.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneGmailWebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadDesktopClass: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  samsungInternet: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  googlebotSmartphone: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  inspectionToolPhone: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0)',
  storebotMobile: 'Mozilla/5.0 (Linux; Android 8.0; Pixel 2 Build/OPD3.170816.012; Storebot-Google/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  googleOtherPhone: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36 (compatible; GoogleOther)',
  lighthousePsi: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
  applebotIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  slackbot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  whatsapp: 'WhatsApp/2.23.20.0 A',
  facebookBare: 'facebookexternalhit/1.1',
  fireTablet: 'Mozilla/5.0 (Linux; Android 9; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/130.4.1 like Chrome/130.0.0.0 Mobile Safari/537.36',
  huawei: 'Mozilla/5.0 (Linux; Android 10; HarmonyOS; ELS-NX9) AppleWebKit/537.36 (KHTML, like Gecko) HuaweiBrowser/15.0.4.312 Mobile Safari/537.36',
};
const WANT: Record<keyof typeof UA, 'ios' | 'android' | 'other'> = {
  iphoneSafari: 'ios',
  iphoneChrome: 'ios',
  iphoneGmailWebview: 'ios',
  ipadDesktopClass: 'other',
  androidChrome: 'android',
  samsungInternet: 'android',
  androidTablet: 'other',
  desktopChrome: 'other',
  googlebotSmartphone: 'other',
  inspectionToolPhone: 'other',
  storebotMobile: 'other',
  googleOtherPhone: 'other',
  lighthousePsi: 'other',
  applebotIphone: 'other',
  slackbot: 'other',
  whatsapp: 'other',
  facebookBare: 'other',
  fireTablet: 'other',
  huawei: 'other',
};
for (const k of Object.keys(UA) as (keyof typeof UA)[]) {
  const got = detectPlatform(UA[k]);
  const want = WANT[k];
  if (got !== want) fail(`detectPlatform(${k}) -> ${got}, expected ${want}`);
  console.log(`  ${k.padEnd(22)} ${got}`);
}
eq("detectPlatform('')", detectPlatform(''), 'other');
eq('detectPlatform(undefined)', detectPlatform(undefined), 'other');
eq('detectPlatform(oversized UA)', detectPlatform('iPhone '.repeat(200)), 'other');

// ── 4. artwork ─────────────────────────────────────────────────────────────
// An entry means the owner dropped the store's unaltered artwork into
// public/badges/. Until then the page renders a text link, not a lookalike.
// Apple ships and Google does not yet (owner decision, 2026-10-13 evening):
// that is ALLOWED, and the Google text link must stay the same height.
console.log('[check-store-links] badge artwork');
for (const [store, art] of Object.entries(STORE_ARTWORK)) {
  if (!art) continue;
  if (!art.src.startsWith('/badges/')) fail(`${store} artwork must live under /badges/`);
  if (!(art.width > 0 && art.height > 0)) fail(`${store} artwork needs its natural width and height`);
  const file = path.join(__dirname, '..', 'public', art.src);
  if (!fs.existsSync(file)) { fail(`${store} artwork file is missing: ${art.src}`); continue; }
  const bytes = fs.readFileSync(file);
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  eq(`${store} artwork sha256 (as the store supplied it)`, got, art.sha256);
  if (!/^[0-9a-f]{64}$/.test(art.sha256)) fail(`${store} artwork sha256 is not a 64-hex digest`);
  if (art.src.endsWith('.svg')) {
    const text = bytes.toString('utf8');
    // The file's own size is the truth; the numbers in STORE_ARTWORK only reserve the aspect ratio.
    const w = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(text)?.[1]);
    const h = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(text)?.[1]);
    if (!(w > 0 && h > 0)) fail(`${store} svg has no width/height on its root`);
    else if (Math.abs(w / h - art.width / art.height) / (w / h) > 0.01) fail(`${store} aspect ${art.width}x${art.height} is more than 1% off the file's ${w}x${h}`);
    // Served from our own origin: no script, handler, foreign object, external or data: reference.
    for (const bad of [/<script/i, /\son[a-z]+\s*=/i, /<foreignObject/i, /<image/i, /<style/i, /\bdata:/i, /\b(?:xlink:)?href\s*=/i]) {
      if (bad.test(text)) fail(`${store} svg contains ${bad}`);
    }
  }
}
// The Apple badge SHIPPED (owner decision, 2026-10-13): its entry may not be deleted quietly.
if (!STORE_ARTWORK.apple) fail('STORE_ARTWORK.apple is missing: the Apple badge shipped 2026-10-13, so removing it needs an edit to this check');
// One shared height for the row: a badge and a text link must never differ.
if (BADGE_HEIGHT_PX < 44) fail(`BADGE_HEIGHT_PX ${BADGE_HEIGHT_PX} is under the 44 px tap target`);
if (BADGE_HEIGHT_PX < 40) fail('Apple requires its badge to be at least 40 px tall on screen');
if (STORE_ARTWORK.apple && STORE_ARTWORK.apple.src.indexOf('_blk_') < 0) fail('Apple artwork must be the BLACK badge (the page tile is light)');
console.log(`  apple: ${STORE_ARTWORK.apple ? STORE_ARTWORK.apple.src : 'NOT YET (text link)'}   google: ${STORE_ARTWORK.google ? STORE_ARTWORK.google.src : 'NOT YET (text link, same height)'}`);
console.log(`  row height ${BADGE_HEIGHT_PX} px, Apple clear space ${APPLE_CLEAR_SPACE_PX} px (the tile's padding and gap are checked against it in check-app-page)`);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nOK');
