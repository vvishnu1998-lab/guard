#!/usr/bin/env ts-node
/**
 * Prove the admin Guards page hands out the guard-app link correctly (W3).
 *
 * 1. THE THREE LINKS ARE THE ONE URL, EACH WITH ITS OWN src TAG. The tags are
 *    how the stores' consoles and our analytics tell a banner tap from a COPY
 *    paste from a QR scan. A tag that fell out of the closed registry would be
 *    counted as 'other' and the surface would vanish from the numbers.
 *
 * 2. THE COPY TEXT STILL STARTS WITH THE OLD TWO LINES, BYTE FOR BYTE, WHATEVER
 *    THE PASSWORD IS. Admins paste it into texts; a password with an
 *    ampersand, a quote or a space must come through untouched, and the new
 *    install link must be alone on the LAST line so chat apps link it.
 *
 * 3. NO STORE OR PLATFORM IS NAMED. The admin cannot know which phone the guard
 *    will use; /app shows the right store. (2.3.10: an iOS bundle must not
 *    name Google Play; the same neutral prose keeps this page from drifting
 *    into that.)
 *
 * 4. THE QR FILE IS EXACTLY WHAT THE GENERATOR WRITES for the 'admin' alias,
 *    so a hand edit, or a payload change without a re-scan, cannot go
 *    unnoticed. It does not prove the code scans: swift scripts/decode-qr.swift
 *    does that, and a phone camera is the last word.
 *
 * 5. THE PAGE USES THE LIB. A literal copy of the URL in page.tsx would drift
 *    from the registry, and the COPY button must call credentialsCopyText.
 *
 * Run: npm run check:guard-handoff (from apps/web). Not postinstall.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ADDED_INSTALL_LINE,
  BANNER_URL,
  COPY_APP_LINE,
  COPY_URL,
  LINK_TEXT,
  MODAL_HELPER_LINE,
  PANEL_LEAD,
  PANEL_QR_ALT,
  PANEL_QR_SRC,
  PANEL_URL,
  credentialsCopyText,
} from '../lib/guardAppHandoff';
import { SRC_REGISTRY, normalizeSrc } from '../lib/storeLinks';

const WEB = path.resolve(__dirname, '..');

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL  ${m}`); };
const eq = (label: string, got: unknown, want: unknown) => {
  if (got !== want) fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// ── 1. the links ───────────────────────────────────────────────────────────
console.log('[check-guard-handoff] links');
eq('BANNER_URL', BANNER_URL, 'https://www.netraops.com/app?src=admin_banner');
eq('COPY_URL', COPY_URL, 'https://www.netraops.com/app?src=admin_copy');
eq('PANEL_URL', PANEL_URL, 'https://www.netraops.com/app?src=admin');
eq('LINK_TEXT', LINK_TEXT, 'www.netraops.com/app');
for (const [label, url] of [['BANNER_URL', BANNER_URL], ['COPY_URL', COPY_URL], ['PANEL_URL', PANEL_URL]] as const) {
  const tag = new URL(url).searchParams.get('src') ?? '';
  eq(`${label} src is registered (normalizeSrc keeps it)`, normalizeSrc(tag), tag);
  eq(`${label} src bucket`, (SRC_REGISTRY as Record<string, string>)[tag], 'admin');
  if (/[&\s<>"']/.test(url)) fail(`${label} has a character that breaks in a text or an attribute: ${url}`);
}
if (new Set([BANNER_URL, COPY_URL, PANEL_URL]).size !== 3) fail('the three surfaces must carry three different src tags');

// ── 2. the COPY text ───────────────────────────────────────────────────────
console.log('[check-guard-handoff] COPY text');
const PASSWORDS = [
  'Temp-Pass-1234',
  'a&b=c?d',
  `quo"te'and<tag>`,
  'with space  inside',
  'pässwörd-Ünï',
  '%26&amp;',
  '0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789',
];
for (const pw of PASSWORDS) {
  const email = 'guard@example.com';
  const text = credentialsCopyText(email, pw);
  const legacy = `Email: ${email}\nPassword: ${pw}`;
  if (!text.startsWith(legacy + '\n')) fail(`the first two lines changed for password ${JSON.stringify(pw.slice(0, 20))}`);
  const rest = text.slice(legacy.length);
  eq(`tail after the credentials (${JSON.stringify(pw.slice(0, 12))})`, rest, `\n\n${COPY_APP_LINE}\n${COPY_URL}`);
  const lines = text.split('\n');
  eq('last line is the link alone', lines[lines.length - 1], COPY_URL);
  eq('the line before the link', lines[lines.length - 2], COPY_APP_LINE);
  eq('a blank line separates credentials from the install text', lines[lines.length - 3], '');
  eq('line count', lines.length, 5);
}
if (!credentialsCopyText('a@b.co', 'x').endsWith(COPY_URL)) fail('the text must END with the link (no trailing newline or space)');
// Everything the lib adds is ASCII, <= 78 columns.
for (const [label, s] of Object.entries({ COPY_APP_LINE, COPY_URL, BANNER_URL, PANEL_URL, ADDED_INSTALL_LINE, MODAL_HELPER_LINE, PANEL_LEAD, PANEL_QR_ALT, LINK_TEXT })) {
  if (/[^\x20-\x7e]/.test(s)) fail(`${label} has a non-ASCII character`);
}
for (const s of [COPY_APP_LINE, COPY_URL]) if (s.length > 78) fail(`line over 78 columns: ${s}`);

// ── 3. neutral prose ───────────────────────────────────────────────────────
console.log('[check-guard-handoff] neutral prose');
const NAMED = /app\s*store|google|play\s*store|testflight|apple|android|iphone|ipad|\bios\b/i;
for (const [label, s] of Object.entries({ COPY_APP_LINE, ADDED_INSTALL_LINE, MODAL_HELPER_LINE, PANEL_LEAD, PANEL_QR_ALT, LINK_TEXT })) {
  if (NAMED.test(s)) fail(`${label} names a store or a platform: ${JSON.stringify(s)}`);
}
// The create route answers 201 BEFORE it sends the email and tells Sentry, not the
// admin, about a failure; the banner must not claim the email was sent.
if (/\b(was|has been|were) sent\b|\bsent to\b/i.test(ADDED_INSTALL_LINE)) fail('ADDED_INSTALL_LINE claims the email was sent');

// ── 4. the QR file ─────────────────────────────────────────────────────────
console.log('[check-guard-handoff] QR asset');
eq('PANEL_QR_SRC', PANEL_QR_SRC, '/qr/app-admin.svg');
const qrPath = path.join(WEB, 'public', PANEL_QR_SRC);
if (!fs.existsSync(qrPath)) {
  fail(`${PANEL_QR_SRC} is missing`);
} else {
  const have = fs.readFileSync(qrPath, 'utf8');
  if (!have.startsWith('<svg ')) fail('QR asset is not an SVG');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-admin-'));
  const out = path.join(tmp, 'app-admin.svg');
  try {
    execFileSync('node', [path.join(WEB, 'scripts', 'gen-store-qr.js'), 'admin', out], { stdio: ['ignore', 'pipe', 'pipe'] });
    eq('QR asset is byte-identical to the generator output for the admin alias', fs.readFileSync(out, 'utf8') === have, true);
  } catch (e: any) {
    fail(`the QR generator could not run (exit ${e?.status}): ${String(e?.stderr ?? e).trim().slice(0, 200)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 5. the page uses the lib ───────────────────────────────────────────────
console.log('[check-guard-handoff] page wiring');
const page = fs.readFileSync(path.join(WEB, 'app', 'admin', 'guards', 'page.tsx'), 'utf8');
if (!/from '\.\.\/\.\.\/\.\.\/lib\/guardAppHandoff'/.test(page)) fail('page.tsx does not import lib/guardAppHandoff');
if (/netraops\.com/i.test(page)) fail('page.tsx hard-codes a netraops.com address; it must come from lib/guardAppHandoff');
if (!/copyText\(credentialsCopyText\(/.test(page)) fail('the credentials COPY button does not call credentialsCopyText');
if (!/copyText\(BANNER_URL, 'banner'\)/.test(page)) fail('the Guard added banner has no COPY LINK for BANNER_URL');
if (!/copyText\(PANEL_URL, 'panel'\)/.test(page)) fail('the GUARD APP panel has no COPY LINK for PANEL_URL');
if (!/src=\{PANEL_QR_SRC\}/.test(page)) fail('the GUARD APP panel does not render PANEL_QR_SRC');
if (!/\{BANNER_URL\}/.test(page) || !/\{PANEL_URL\}/.test(page)) fail('the links must be on screen as selectable text');
// What the page RENDERS, not just what the lib exports: a hard-coded string, a dropped
// line, a panel that opens by default or hides below a breakpoint all slip past a lib-only check.
const need = (label: string, re: RegExp) => { if (!re.test(page)) fail(`page.tsx: ${label}`); };
need('the Guard added banner does not render {ADDED_INSTALL_LINE}', /\{ADDED_INSTALL_LINE\}/);
need('the Add Guard modal does not render {MODAL_HELPER_LINE}', /\{MODAL_HELPER_LINE\}/);
need('the GUARD APP panel does not render {PANEL_LEAD}', /\{PANEL_LEAD\}/);
need('the QR image alt is not {PANEL_QR_ALT}', /alt=\{PANEL_QR_ALT\}/);
const detailsTag = /<details[^>]*>/.exec(page)?.[0] ?? '';
if (!detailsTag) fail('page.tsx: no <details> panel');
if (/\sopen[\s=>{]/.test(detailsTag)) fail('the GUARD APP panel must be collapsed by default (no open attribute)');
if (/(^|[\s"])(?:[a-z]+:)?hidden(?=[\s"])/.test(/className="([^"]*)"/.exec(detailsTag)?.[1] ?? '')) fail('the GUARD APP panel must be shown at every width (a hidden class is on <details>)');
// COPIED only after the clipboard write RESOLVES, and the old COPY button label stays COPY otherwise.
need('setCopied must run inside .then() of the clipboard write', /navigator\.clipboard\?\.writeText\(text\)\s*\.then\(\(\) => \{\s*setCopied\(key\)/);
// The create route answers 201 before it sends, so the page must not claim the welcome email WAS sent.
if (/welcome email (?:was|has been|is being) sent/i.test(page)) fail('page.tsx claims the welcome email was sent');

// User-visible copy on the page must not name a store or a platform either.
// Comments are stripped first (they may explain why); what is left is code and copy.
const pageNoComments = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const named = pageNoComments.match(NAMED);
if (named) fail(`page.tsx names a store or a platform outside a comment: ${JSON.stringify(named[0])}`);

console.log(failures === 0 ? '\n[check-guard-handoff] OK' : `\n[check-guard-handoff] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
