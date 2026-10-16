#!/usr/bin/env ts-node
/**
 * Prove the public site links to the guard app the way the rollout decided
 * (N188 W2), against a RUNNING server (`next build && next start`, or production):
 *
 *   APP_BASE=http://localhost:3101 npm run check:site-links
 *   APP_BASE=https://www.netraops.com npm run check:site-links      (post-deploy)
 *
 * What it pins, and why:
 *
 * 1. EVERY PLACEMENT LINKS TO THE ONE URL WITH ITS OWN src TAG. For each page
 *    the multiset of links to https://www.netraops.com/app is EXACTLY the list
 *    below: a placement that fell out is a missing link, and an extra or a
 *    duplicate is a surface the stores' consoles and our own page-view counts
 *    cannot tell apart. Each tag is in the closed registry, so none of them
 *    collapses to 'other'.
 * 2. TEXT LINKS GO TO /app, NEVER STRAIGHT TO A STORE. The only link from the
 *    public site to a store listing is Apple's own badge on homepage step 02,
 *    which (like the /app badges) links directly. No page links to Google Play.
 * 3. THE APPLE BADGE IS APPLE'S, UNALTERED, ON A LIGHT TILE WITH ITS CLEAR
 *    SPACE. The artwork the site serves is byte-identical to the file the store
 *    supplied (sha256 pinned in lib/storeLinks.ts), it is shown 56 px tall, and
 *    the tile's padding (p-4 = 16 px) is larger than a quarter of the badge
 *    height (14 px). Google has no badge file yet, so no Google badge or
 *    lookalike is on any page.
 * 4. PAGES THAT ARE NOT PART OF W2 DID NOT GAIN A LINK (/privacy, /terms,
 *    /security), and the pages that are keep their other content: the checker
 *    does not read copy, so diff the HTML before and after by hand for that.
 * 5. NO PLACEMENT HARD-CODES THE URL. Each source file builds its href from
 *    appLink('<tag>') / appStoreHref('<tag>'), so the registry stays the
 *    single source of tags.
 * 6. /admin/login IS CLIENT-RENDERED (in production today as well): its server
 *    HTML is Next's client-side-rendering shell, so the checker can only read the
 *    page's own JavaScript chunk for the link. That proves the link ships, not
 *    that it renders; open the page in a browser for that.
 *
 * Not postinstall; not in CI (it needs a server).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  APP_PAGE_URL,
  APP_STORE_URL,
  APPLE_CLEAR_SPACE_PX,
  BADGE_HEIGHT_PX,
  PLAY_STORE_URL,
  SRC_REGISTRY,
  STORE_ARTWORK,
  SrcTag,
  appLink,
  appStoreHref,
  normalizeSrc,
} from '../lib/storeLinks';

const WEB = path.resolve(__dirname, '..');
const BASE = (process.env.APP_BASE ?? 'http://localhost:3000').replace(/\/$/, '');

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL  ${m}`); };
const ok = (m: string) => console.log(`  ok    ${m}`);

/**
 * Placements per page: the /app links the page must carry, one entry per link.
 * `csr`: the page's server HTML is only Next's client-side-rendering shell
 * (/admin/login reads useSearchParams outside a Suspense boundary, and does the
 * same in production today), so its link exists only after hydration. For that
 * page the checker reads the page's own JavaScript chunk instead; whether the
 * link RENDERS is a browser check (see the PR).
 */
const PAGES: { path: string; tags: SrcTag[]; csr?: { chunk: RegExp; needles: RegExp[] } }[] = [
  { path: '/', tags: ['site_nav', 'home_step2', 'site_faq', 'site_footer'] },
  { path: '/demo', tags: ['site_nav', 'site_demo'] },
  { path: '/customers/starnet', tags: ['site_nav', 'site_footer'] },
  { path: '/portal', tags: ['login_portal'] },
  {
    path: '/admin/login',
    tags: ['login_admin'],
    csr: {
      chunk: /static\/chunks\/app\/admin\/login\/page-[a-z0-9]+\.js/,
      needles: [/\(["']login_admin["']\)/, /Are you a guard\?/, /Get the app/],
    },
  },
  { path: '/support', tags: ['site_support'] },
  { path: '/data-deletion', tags: ['site_deletion'] },
];

/** Pages W2 deliberately did not touch. */
const UNTOUCHED = ['/privacy', '/terms', '/security'];

/** Source files and the tag each one must build its href from. */
const SOURCES: { file: string; calls: string[] }[] = [
  { file: 'components/marketing/NavBar.tsx', calls: ["appLink('site_nav')"] },
  { file: 'components/marketing/FaqSection.tsx', calls: ["appLink('site_faq')"] },
  { file: 'components/marketing/Step2AppLinks.tsx', calls: ["appLink('home_step2')", "appStoreHref('home_step2')"] },
  { file: 'app/page.tsx', calls: ["appLink('site_footer')"] },
  { file: 'app/demo/page.tsx', calls: ["appLink('site_demo')"] },
  { file: 'app/customers/starnet/page.tsx', calls: ["appLink('site_footer')"] },
  { file: 'app/portal/page.tsx', calls: ["appLink('login_portal')"] },
  { file: 'app/admin/login/page.tsx', calls: ["appLink('login_admin')"] },
  { file: 'app/support/page.tsx', calls: ["appLink('site_support')"] },
  { file: 'app/data-deletion/page.tsx', calls: ["appLink('site_deletion')"] },
];

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

async function get(p: string): Promise<{ status: number; body: string }> {
  const res = await fetch(BASE + p, { redirect: 'manual', headers: { 'user-agent': 'check-site-links' } });
  return { status: res.status, body: await res.text() };
}

/** Every <a ...> tag: its decoded href and the raw tag text. */
function anchors(html: string): { href: string; tag: string }[] {
  const out: { href: string; tag: string }[] = [];
  const re = /<a\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const h = /\bhref="([^"]*)"/i.exec(m[0]);
    if (h) out.push({ href: decode(h[1]), tag: m[0] });
  }
  return out;
}

function sourceChecks() {
  console.log('[check-site-links] sources');
  const before = failures;
  for (const s of SOURCES) {
    const text = fs.readFileSync(path.join(WEB, s.file), 'utf8');
    for (const call of s.calls) {
      const n = text.split(call).length - 1;
      if (n !== 1) fail(`${s.file}: expected exactly one ${call}, found ${n}`);
    }
    if (/netraops\.com\/app/.test(text)) fail(`${s.file} hard-codes the /app URL; it must come from appLink()`);
  }
  const used = ['site_nav', 'home_step2', 'site_faq', 'site_footer', 'site_demo', 'login_portal', 'login_admin', 'site_support', 'site_deletion'];
  for (const t of used) {
    if (normalizeSrc(t) !== t) fail(`tag ${t} is not in the registry (it would collapse to other)`);
    if ((SRC_REGISTRY as Record<string, string>)[t] !== 'site') fail(`tag ${t} should be in the site bucket`);
  }
  if (failures === before) ok(`${SOURCES.length} source files build their hrefs from the registry`);
}

async function pageChecks() {
  console.log(`[check-site-links] pages on ${BASE}`);
  for (const page of PAGES) {
    const r = await get(page.path);
    if (r.status !== 200) { fail(`${page.path}: HTTP ${r.status}`); continue; }
    if (page.csr) {
      const chunkPath = page.csr.chunk.exec(r.body)?.[0];
      if (!chunkPath) { fail(`${page.path}: its page chunk is not referenced from the HTML`); continue; }
      const js = await fetch(`${BASE}/_next/${chunkPath}`, { headers: { 'user-agent': 'check-site-links' } });
      const code = await js.text();
      const missing = page.csr.needles.filter((n) => !n.test(code));
      if (js.status !== 200 || missing.length > 0) {
        fail(`${page.path}: chunk ${chunkPath} (HTTP ${js.status}) lacks ${missing.map(String).join(', ')}`);
      } else {
        ok(`${page.path}: client-rendered; its chunk carries the ${page.tags.join(', ')} link (render it in a browser)`);
      }
      continue;
    }
    const as = anchors(r.body);
    const app = as.filter((a) => a.href.indexOf(APP_PAGE_URL) === 0).map((a) => a.href).sort();
    const want = page.tags.map((t) => appLink(t)).sort();
    if (JSON.stringify(app) !== JSON.stringify(want)) {
      fail(`${page.path}: links to /app are\n          ${JSON.stringify(app)}\n        want\n          ${JSON.stringify(want)}`);
    } else {
      ok(`${page.path}: ${want.length} link${want.length === 1 ? '' : 's'} to /app, tags ${page.tags.join(', ')}`);
    }
    for (const a of as) {
      if (a.href.indexOf(APP_PAGE_URL) === 0 && /[\s<>"']/.test(a.href)) fail(`${page.path}: ${a.href} has a character that breaks in an attribute`);
      if (a.href.indexOf('play.google.com') >= 0) fail(`${page.path}: links straight to Google Play (${a.href})`);
    }
    // Direct store links: only the Apple badge, only on the homepage.
    const store = as.filter((a) => a.href.indexOf(APP_STORE_URL) === 0 || a.href.indexOf(PLAY_STORE_URL) === 0);
    const wantStore = page.path === '/' ? [appStoreHref('home_step2')] : [];
    if (JSON.stringify(store.map((a) => a.href)) !== JSON.stringify(wantStore)) {
      fail(`${page.path}: direct store links are ${JSON.stringify(store.map((a) => a.href))}, want ${JSON.stringify(wantStore)}`);
    }
  }
  for (const p of UNTOUCHED) {
    const r = await get(p);
    if (r.status !== 200) { fail(`${p}: HTTP ${r.status}`); continue; }
    const n = anchors(r.body).filter((a) => a.href.indexOf(APP_PAGE_URL) === 0).length;
    if (n !== 0) fail(`${p}: has ${n} link(s) to /app; W2 did not touch this page`);
    else ok(`${p}: untouched (0 links to /app)`);
  }
}

async function appleBadgeChecks() {
  console.log('[check-site-links] Apple badge on homepage step 02');
  const before = failures;
  const art = STORE_ARTWORK.apple;
  if (!art) { fail('STORE_ARTWORK.apple is missing, so step 02 would have no badge'); return; }
  const html = (await get('/')).body;
  const badge = anchors(html).filter((a) => /data-step2="apple"/.test(a.tag));
  if (badge.length !== 1) { fail(`expected one data-step2="apple" anchor, found ${badge.length}`); return; }
  if (badge[0].href !== appStoreHref('home_step2')) fail(`badge href ${badge[0].href}`);
  // The tile (the anchor) is light and has room around the badge.
  const cls = /class="([^"]*)"/.exec(badge[0].tag)?.[1] ?? '';
  if (!/\bbg-\[#F5F3EE\]/.test(cls)) fail(`the badge tile is not the light tile: class="${cls}"`);
  const pad = /\bp-(\d+)\b/.exec(cls);
  const padPx = pad ? Number(pad[1]) * 4 : 0;
  if (padPx <= APPLE_CLEAR_SPACE_PX) fail(`tile padding ${padPx}px is not larger than the ${APPLE_CLEAR_SPACE_PX}px clear space`);
  // The image inside the anchor.
  const at = html.indexOf(badge[0].tag);
  const inside = html.slice(at, html.indexOf('</a>', at));
  const img = /<img\b[^>]*>/i.exec(inside)?.[0] ?? '';
  const src = /\bsrc="([^"]*)"/i.exec(img)?.[1];
  if (src !== art.src) fail(`badge img src is ${src}, want ${art.src}`);
  if (!new RegExp(`height:\\s*${BADGE_HEIGHT_PX}px`).test(img)) fail(`badge is not ${BADGE_HEIGHT_PX}px tall: ${img}`);
  if (!/\balt="Download on the App Store"/.test(img)) fail('badge alt is not "Download on the App Store"');
  // The bytes the site serves are the bytes Apple supplied.
  const res = await fetch(BASE + art.src, { headers: { 'user-agent': 'check-site-links' } });
  const bytes = Buffer.from(await res.arrayBuffer());
  const have = crypto.createHash('sha256').update(bytes).digest('hex');
  if (res.status !== 200 || have !== art.sha256) fail(`served badge artwork: HTTP ${res.status}, sha256 ${have}, want ${art.sha256}`);
  // No Google badge or lookalike on any W2 page.
  for (const page of PAGES) {
    const h = (await get(page.path)).body;
    if (/<img\b[^>]*(google|play[-_]?store|get[-_]?it[-_]?on)/i.test(h)) fail(`${page.path}: an image looks like a Google Play badge`);
  }
  if (failures === before) ok('Apple badge: direct link, light tile, 56px, clear space, unaltered bytes; no Google badge anywhere');
}

async function main() {
  sourceChecks();
  await pageChecks();
  await appleBadgeChecks();
  console.log(failures === 0 ? '\n[check-site-links] OK' : `\n[check-site-links] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[check-site-links] could not run:', e);
  process.exit(1);
});
