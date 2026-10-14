#!/usr/bin/env ts-node
/**
 * Prove the /app page does what the one-URL decision needs it to do, against a
 * RUNNING server (`next build && next start`, or production):
 *
 *   APP_BASE=http://localhost:3101 npm run check:app-page
 *   APP_BASE=https://www.netraops.com npm run check:app-page      (post-deploy)
 *
 * What it pins, and why:
 *
 * 1. IDENTICAL BYTES FOR EVERY USER AGENT, NO REDIRECT, NO Vary: User-Agent.
 *    Every email, QR code and notice now points at this one URL. Googlebot
 *    Smartphone is an Android UA; Slack, iMessage and WhatsApp previewers fetch
 *    pasted links; a per-UA response would show them something other than what
 *    people get, and a redirect would send a previewer to a store page.
 * 2. THE ?src= TAG NEVER CHANGES THE SERVER OUTPUT AND IS NEVER ECHOED. A
 *    hostile value must produce the same page, byte for byte.
 * 3. THE BADGES LINK STRAIGHT TO THE STORES OF RECORD, with fixed page tags.
 *    Apple's official badge is on the left and Google Play is a text link of
 *    the SAME height on the right (until Google's artwork lands); the artwork
 *    the SITE SERVES is byte-identical to the file the store supplied (a CDN
 *    transform or an "optimised" copy would fail); on a confident iPhone the
 *    Google wording hides and on Android the App Store wording hides, by CSS
 *    only: the server HTML stays one byte-identical page.
 * 4. SHARE + SEO: canonical /app, its own Open Graph block (with the inherited
 *    image), indexable, honest JSON-LD (no rating, review or offers), and no
 *    Smart App Banner tag (a decision, not an omission).
 * 5. app.netraops.com/app (the second host serving the whole site) goes to the
 *    one www URL.
 *
 * Not postinstall; not in CI (it needs a server).
 */
import * as crypto from 'crypto';
import * as http from 'http';
import { APPLE_CLEAR_SPACE_PX, APP_PAGE_URL, APP_STORE_URL, BADGE_HEIGHT_PX, STORE_ARTWORK, appStoreHref, playHref } from '../lib/storeLinks';

const BASE = (process.env.APP_BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const IS_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE);

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL  ${m}`); };
const ok = (m: string) => console.log(`  ok    ${m}`);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

const UAS: Record<string, string> = {
  none: '',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  googlebotSmartphone: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  inspectionTool: 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
  slackbot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  whatsapp: 'WhatsApp/2.23.20.0 A',
  facebook: 'facebookexternalhit/1.1',
};

async function get(path: string, ua = 'check-app-page'): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(BASE + path, { redirect: 'manual', headers: ua ? { 'user-agent': ua } : {} });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

function hostGet(path: string, host: string): Promise<{ status: number; location?: string }> {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers: { host } }, (r) => {
      r.resume();
      resolve({ status: r.statusCode ?? 0, location: r.headers.location });
    });
    req.on('error', reject);
    req.end();
  });
}

const attr = (html: string, re: RegExp) => re.exec(html)?.[1];
const metaContent = (html: string, key: string) =>
  attr(html, new RegExp(`<meta[^>]+(?:property|name)="${key}"[^>]+content="([^"]*)"`, 'i')) ??
  attr(html, new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${key}"`, 'i'));
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

async function main() {
  console.log(`[check-app-page] ${BASE}`);

  // ── 1. identical bytes for every UA ──────────────────────────────────────
  console.log('[check-app-page] one response for every user agent');
  const hashes = new Map<string, string>();
  let ref: { status: number; headers: Headers; body: string } | undefined;
  for (const [name, ua] of Object.entries(UAS)) {
    const r = await get('/app', ua);
    if (!ref) ref = r;
    if (r.status !== 200) fail(`${name}: status ${r.status}, expected 200 (a redirect would send previewers to a store)`);
    if (r.headers.get('location')) fail(`${name}: has a Location header`);
    const vary = r.headers.get('vary') ?? '';
    if (/user-agent/i.test(vary)) fail(`${name}: Vary includes User-Agent (${vary})`);
    if (!/text\/html/.test(r.headers.get('content-type') ?? '')) fail(`${name}: content-type ${r.headers.get('content-type')}`);
    hashes.set(name, sha(r.body));
  }
  const distinct = new Set(hashes.values());
  if (distinct.size !== 1) fail(`HTML differs by user agent: ${JSON.stringify(Object.fromEntries(hashes))}`);
  else ok(`${hashes.size} user agents -> 1 distinct response (${Array.from(distinct)[0]}), 200, no Location, no Vary: User-Agent`);
  const html = ref!.body;
  const head = await fetch(BASE + '/app', { method: 'HEAD', redirect: 'manual' });
  if (head.status !== 200) fail(`HEAD /app -> ${head.status}`);

  // ── 2. src never changes output, never echoed ────────────────────────────
  console.log('[check-app-page] the src tag');
  const base = sha(html);
  for (const src of ['welcome_email', 'qa_test', '<script>alert(1)</script>', 'javascript:alert(1)', 'x'.repeat(3000)]) {
    const r = await get('/app?src=' + encodeURIComponent(src));
    if (r.status !== 200) fail(`/app?src=${src.slice(0, 20)} -> ${r.status}`);
    if (sha(r.body) !== base) fail(`/app?src=${src.slice(0, 20)}... changes the server HTML`);
    if (src.length > 3 && r.body.includes(src)) fail(`src value echoed into the page: ${src.slice(0, 20)}`);
  }
  ok('known and hostile src values all return the identical page; none echoed');

  // ── 3. the badges ────────────────────────────────────────────────────────
  console.log('[check-app-page] store links');
  const hrefs = Array.from(html.matchAll(/<a[^>]*data-store="(apple|google)"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*data-store="(apple|google)"/g))
    .map((m) => ({ store: m[1] ?? m[4], href: decode(m[2] ?? m[3]) }));
  const apple = hrefs.find((h) => h.store === 'apple');
  const google = hrefs.find((h) => h.store === 'google');
  if (!apple) fail('no data-store="apple" anchor');
  else if (apple.href !== appStoreHref('app_page')) fail(`Apple href ${apple.href} != ${appStoreHref('app_page')}`);
  else ok(`Apple badge -> ${apple.href}`);
  if (!google) fail('no data-store="google" anchor');
  else if (google.href !== playHref('app_page')) fail(`Google href ${google.href} != ${playHref('app_page')}`);
  else ok(`Google badge -> ${google.href}`);
  if (apple && !apple.href.startsWith(APP_STORE_URL)) fail('Apple href must start with the App Store URL of record');
  // Apple first in the DOM (Apple's rule: first in a lineup).
  if (html.indexOf('data-store="apple"') > html.indexOf('data-store="google"')) fail('Apple badge must come first in the DOM');
  if (/apple-itunes-app/i.test(html)) fail('apple-itunes-app (Smart App Banner) present: decided against for now');
  // ── the row: Apple badge (an <img> inside its link) left, Google a text link, one height ──
  // Everything below reads the SERVED html, by exact tokens and parsed declarations (not by
  // substring), so `max-height:56px`, `group/main` or `...:hidden-x` cannot pass for the real thing.
  const EXPECTED_APPLE_SRC = '/badges/Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg';
  const ALT = { apple: 'Download on the App Store', google: 'Get it on Google Play' } as const;
  const HIDE = { ios: 'group-data-[platform=ios]:hidden', android: 'group-data-[platform=android]:hidden' } as const;
  const tokens = (s: string | undefined) => (s ?? '').split(/\s+/).filter(Boolean);
  const classOf = (tag: string) => tokens(/\sclass="([^"]*)"/.exec(tag)?.[1]);
  const styleOf = (tag: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const d of (/\sstyle="([^"]*)"/.exec(tag)?.[1] ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim().toLowerCase();
    }
    return out;
  };
  const openTag = (store: 'apple' | 'google') => new RegExp(`<a[^>]*data-store="${store}"[^>]*>`).exec(html)?.[0] ?? '';
  const inner = (store: 'apple' | 'google') => new RegExp(`<a[^>]*data-store="${store}"[^>]*>([\\s\\S]*?)</a>`).exec(html)?.[1] ?? '';
  const sameStyle = (got: Record<string, string>, want: Record<string, string>) => JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(want).sort());
  const px = `${BADGE_HEIGHT_PX}px`;

  // The Apple badge has SHIPPED (owner decision 2026-10-13): deleting its STORE_ARTWORK entry, or
  // pointing it elsewhere, must fail here, not quietly fall back to a text link.
  if (!STORE_ARTWORK.apple) fail('STORE_ARTWORK.apple is missing: the Apple badge shipped 2026-10-13, so removing it needs an edit to this check');
  else if (STORE_ARTWORK.apple.src !== EXPECTED_APPLE_SRC) fail(`STORE_ARTWORK.apple.src ${STORE_ARTWORK.apple.src} != ${EXPECTED_APPLE_SRC}`);
  if (html.split('data-store="').length !== 3) fail(`expected exactly two data-store anchors, found ${html.split('data-store="').length - 1}`);

  for (const store of ['apple', 'google'] as const) {
    const a = store === 'apple' ? STORE_ARTWORK.apple : STORE_ARTWORK.google;
    const body = inner(store);
    const tag = openTag(store);
    // anchor: its own platform-hide token (and NOT the other one), the shared row height, nothing else in style
    const cls = classOf(tag);
    const own = store === 'apple' ? HIDE.android : HIDE.ios;
    const other = store === 'apple' ? HIDE.ios : HIDE.android;
    if (!cls.includes(own)) fail(`${store}: the link must carry the exact class token ${own} (hidden on the OTHER platform): ${cls.join(' ')}`);
    if (cls.includes(other)) fail(`${store}: the link must NOT carry ${other}: ${cls.join(' ')}`);
    if (!sameStyle(styleOf(tag), { 'min-height': px })) fail(`${store}: link style must be exactly min-height:${px}: ${JSON.stringify(styleOf(tag))}`);
    if (a) {
      const imgTag = /<img\b[^>]*>/.exec(body)?.[0] ?? '';
      if (!imgTag) fail(`${store}: the official badge image is not inside its link`);
      else {
        if (!new RegExp(`\\ssrc="${a.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(imgTag)) fail(`${store}: <img> src is not ${a.src}: ${imgTag}`);
        if ((/\salt="([^"]*)"/.exec(imgTag)?.[1] ?? '') !== ALT[store]) fail(`${store}: badge alt must be exactly "${ALT[store]}": ${imgTag}`);
        if (!sameStyle(styleOf(imgTag), { height: px, width: 'auto' })) fail(`${store}: badge <img> style must be exactly height:${px};width:auto: ${JSON.stringify(styleOf(imgTag))}`);
        if (body.replace(imgTag, '').trim() !== '') fail(`${store}: the badge link holds more than the image (the quarter-height clear space must be empty): ${body.replace(imgTag, '').trim().slice(0, 80)}`);
        else ok(`${store}: official badge ${a.src}, ${px} tall, link holds only the image`);
      }
      // The served bytes are the store's file, byte for byte (no CDN transform, no re-save).
      const asset = await fetch(BASE + a.src);
      const buf = Buffer.from(await asset.arrayBuffer());
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      const wantType = a.src.endsWith('.svg') ? /image\/svg\+xml/ : a.src.endsWith('.png') ? /image\/png/ : /image\//;
      if (asset.status !== 200) fail(`${store} artwork -> ${asset.status}`);
      else if (!wantType.test(asset.headers.get('content-type') ?? '')) fail(`${store} artwork content-type ${asset.headers.get('content-type')}`);
      else if (got !== a.sha256) fail(`${store} artwork bytes served by the site (${got.slice(0, 12)}) differ from the file the store supplied (${a.sha256.slice(0, 12)})`);
      else ok(`${store} artwork served byte-identical to the store's file (sha256 ${got.slice(0, 12)})`);
    } else {
      // No official artwork yet: a plain text link, never a lookalike badge.
      const spanTag = /<span\b[^>]*>/.exec(body)?.[0] ?? '';
      const label = store === 'apple' ? 'Available on the App Store' : 'Available on Google Play';
      if (/<img/.test(body)) fail(`${store}: an image inside a link that has no official artwork (a lookalike badge?)`);
      else if (body.replace(/<[^>]+>/g, '').trim() !== label) fail(`${store}: text link wording must be exactly "${label}": ${body.slice(0, 120)}`);
      else ok(`${store}: text link "${label}" (no official artwork yet)`);
      if (styleOf(spanTag)['min-height'] !== px) fail(`${store}: the text link's inner box is not min-height:${px}: ${JSON.stringify(styleOf(spanTag))}`);
      for (const bad of ['padding', 'margin', 'max-height', 'line-height', 'height', 'width']) {
        if (bad in styleOf(spanTag) || bad in styleOf(tag)) fail(`${store}: text link style must not set ${bad} (it would change the row height)`);
      }
    }
  }

  // ── platform wording: ONE marker on <main id="store-links">, hidden by CSS only ──
  const mainTag = /<main\b[^>]*>/.exec(html)?.[0] ?? '';
  if (!/\sid="store-links"/.test(mainTag) || !/\sdata-platform="other"/.test(mainTag) || !classOf(mainTag).includes('group')) {
    fail(`<main> must carry id="store-links", data-platform="other" and the exact class token "group": ${mainTag}`);
  } else ok('platform marker on <main id="store-links"> (server value "other", exact "group" token)');
  // The CENSUS: exactly these elements carry a platform-hide class, no more (a stray hide on any other
  // element would make content vanish on a phone), and each has exactly the token it should.
  const hidden = Array.from(html.matchAll(/<(\w+)\b[^>]*\sclass="([^"]*group-data-\[platform=[^"]*)"[^>]*>/g)).map((m) => ({ el: m[1], cls: tokens(m[2]) }));
  const key = (h: { el: string; cls: string[] }) => `${h.el}:${[...h.cls.filter((t) => t.startsWith('group-data-'))].sort().join('+')}`;
  const census = hidden.map(key).sort();
  const wantCensus = [
    `a:${HIDE.android}`,                         // Apple link
    `a:${HIDE.ios}`,                             // Google link
    `p:${HIDE.ios}`,                             // "No Google Play on your phone" line
    `span:${HIDE.android}`,                      // "the App Store" in "Can't find it?"
    `span:${HIDE.ios}`,                          // "Google Play" in "Can't find it?"
    `span:${[HIDE.android, HIDE.ios].sort().join('+')}`, // the " or " between them
  ].sort();
  if (JSON.stringify(census) !== JSON.stringify(wantCensus)) fail(`platform-hidden elements are not exactly the expected six.\n         got  ${JSON.stringify(census)}\n         want ${JSON.stringify(wantCensus)}`);
  else ok('exactly six platform-hidden elements, each with exactly its tokens');
  const noPlay = /<p\b[^>]*\sclass="([^"]*)"[^>]*>\s*<span\b[^>]*>No Google Play on your phone/.exec(html);
  if (!noPlay || !tokens(noPlay[1]).includes(HIDE.ios)) fail('the "No Google Play on your phone" line must carry the exact token group-data-[platform=ios]:hidden');
  else ok('"No Google Play on your phone" line hidden on iOS');
  const findIt = /Can(?:&#x27;|&#39;|')t find it\?<\/span>[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';
  const spans = Array.from(findIt.matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g)).map((m) => ({ cls: tokens(m[1]).filter((t) => t.startsWith('group-data-')).sort().join('+'), text: m[2] }));
  const wantSpans = [
    { cls: HIDE.android, text: 'the App Store' },
    { cls: [HIDE.android, HIDE.ios].sort().join('+'), text: ' or ' },
    { cls: HIDE.ios, text: 'Google Play' },
  ];
  if (JSON.stringify(spans) !== JSON.stringify(wantSpans)) fail(`"Can't find it?" spans are not [the App Store | " or " | Google Play] with the right hide tokens: ${JSON.stringify(spans)}`);
  else ok('"Can\'t find it?" wording is platform-aware (three spans, exact tokens)');
  // The served STYLESHEET must contain the rules that make those classes do something.
  const sheets = Array.from(html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"|<link[^>]+href="([^"]+)"[^>]+rel="stylesheet"/g)).map((m) => m[1] ?? m[2]);
  let css = '';
  for (const href of sheets) css += await (await fetch(new URL(href, BASE + '/app').toString())).text();
  const rule = /((?:\.group\[data-platform=(?:ios|android)\] \.group-data-\\\[platform\\=(?:ios|android)\\\]\\:hidden,?)+)\{display:none\}/.exec(css)?.[1] ?? '';
  if (!rule.includes('[data-platform=ios]') || !rule.includes('[data-platform=android]')) fail('the served CSS has no display:none rule for both group-data-[platform=ios] and group-data-[platform=android] (Tailwind did not emit the hide rules)');
  else ok('served CSS hides .group-data-[platform=ios|android]:hidden under the matching data-platform');
  // Apple's quarter-height clear space: the tile's padding and its gap are both larger.
  const tileClass = classOf(/<div\b[^>]*>(?=\s*<a[^>]*data-store="apple")/.exec(html)?.[0] ?? '');
  const spacing = tileClass.filter((t) => /^(?:sm:)?(?:p|gap)-\d+$/.test(t)).map((t) => ({ t, px: Number(t.split('-')[1]) * 4 }));
  if (spacing.length < 4 || spacing.some((x) => x.px <= APPLE_CLEAR_SPACE_PX)) fail(`the tile's padding and gap must all exceed Apple's clear space (${APPLE_CLEAR_SPACE_PX}px): ${JSON.stringify(spacing)}`);
  else ok(`tile padding and gap (${spacing.map((x) => `${x.t}=${x.px}px`).join(', ')}) all exceed the ${APPLE_CLEAR_SPACE_PX}px clear space`);
  const qr = attr(html, /<img[^>]+src="(\/qr\/app-desktop\.svg)"/);
  if (!qr) fail('desktop QR image missing');
  else {
    const q = await fetch(BASE + qr);
    if (q.status !== 200 || !/svg/.test(q.headers.get('content-type') ?? '')) fail(`QR asset -> ${q.status} ${q.headers.get('content-type')}`);
    else ok('desktop QR asset served as svg');
  }

  // ── 4. share + SEO ───────────────────────────────────────────────────────
  console.log('[check-app-page] share and SEO');
  const canonical = attr(html, /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/) ?? attr(html, /<link[^>]+href="([^"]+)"[^>]+rel="canonical"/);
  if (canonical !== APP_PAGE_URL) fail(`canonical ${canonical}`);
  else ok(`canonical ${canonical}`);
  if (metaContent(html, 'og:url') !== APP_PAGE_URL) fail(`og:url ${metaContent(html, 'og:url')} (must name /app, not the homepage)`);
  if (metaContent(html, 'og:title') !== 'Get the guard app') fail(`og:title ${metaContent(html, 'og:title')}`);
  if (!metaContent(html, 'og:image')) fail('og:image missing: the page-level OG block replaced the inherited image');
  else ok(`og:image ${metaContent(html, 'og:image')}`);
  if (metaContent(html, 'twitter:card') !== 'summary_large_image') fail('twitter:card');
  if (!metaContent(html, 'twitter:image')) fail('twitter:image missing');
  if (/noindex/i.test(metaContent(html, 'robots') ?? '')) fail('robots meta says noindex');
  if (!/<title>[^<]*Get the guard app[^<]*<\/title>/.test(html)) fail('title');
  const ld = attr(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!ld) fail('no JSON-LD');
  else {
    try {
      const j = JSON.parse(ld);
      if (j['@type'] !== 'MobileApplication') fail(`JSON-LD @type ${j['@type']}`);
      for (const banned of ['aggregateRating', 'review', 'offers']) if (banned in j) fail(`JSON-LD must not claim '${banned}' (no fabricated metrics)`);
      if (JSON.stringify(j.sameAs) !== JSON.stringify([APP_STORE_URL, 'https://play.google.com/store/apps/details?id=com.netraops.guard'])) fail(`JSON-LD sameAs ${JSON.stringify(j.sameAs)}`);
      if (j.publisher?.name !== 'Calvern LLC') fail('JSON-LD publisher');
      ok('JSON-LD parses: MobileApplication, no rating/review/offers, sameAs = the two store URLs');
    } catch (e) { fail(`JSON-LD does not parse: ${(e as Error).message}`); }
  }
  const sm = await get('/sitemap.xml');
  if (!sm.body.includes(`<loc>${APP_PAGE_URL}</loc>`)) fail('sitemap.xml does not list /app');
  else ok('sitemap.xml lists /app');
  const robots = await get('/robots.txt');
  if (/^\s*disallow:\s*\/app\b/im.test(robots.body)) fail('robots.txt disallows /app');
  else ok('robots.txt does not block /app');
  const slash = await fetch(BASE + '/app/', { redirect: 'manual' });
  if (![301, 307, 308, 200].includes(slash.status)) fail(`/app/ -> ${slash.status}`);

  // ── 5. the second host ───────────────────────────────────────────────────
  console.log('[check-app-page] app.netraops.com');
  if (IS_LOCAL) {
    const h = await hostGet('/app?src=welcome_email', 'app.netraops.com');
    if (h.status !== 308 && h.status !== 301) fail(`app host /app -> ${h.status}`);
    else if (!(h.location ?? '').startsWith('https://www.netraops.com/app')) fail(`app host /app Location ${h.location}`);
    else if (!(h.location ?? '').includes('src=welcome_email')) fail(`app host redirect dropped the query: ${h.location}`);
    else ok(`app host /app -> ${h.status} ${h.location}`);
    const portal = await hostGet('/admin', 'app.netraops.com');
    if (portal.location?.includes('www.netraops.com')) fail('the app-host redirect must be limited to /app; /admin was redirected to www');
    else ok(`app host /admin still served on the app host (${portal.status})`);
  } else {
    const r = await fetch('https://app.netraops.com/app?src=welcome_email', { redirect: 'manual' });
    const loc = r.headers.get('location') ?? '';
    if (![301, 308].includes(r.status) || !loc.startsWith('https://www.netraops.com/app') || !loc.includes('src=welcome_email')) fail(`https://app.netraops.com/app -> ${r.status} ${loc}`);
    else ok(`https://app.netraops.com/app -> ${r.status} ${loc}`);
  }

  if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log('\nOK');
}

main().catch((e) => { console.error(e); process.exit(1); });
