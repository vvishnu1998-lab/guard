/**
 * test-letterhead-b5.ts — Phase B, stage B5: the company letterhead on the
 * admin alerts and on the company's account emails; N182 (every email's styles
 * inline, so Gmail renders them); month-name dates in every email.
 *
 *   npx ts-node -P tsconfig.scripts.json scripts/test-letterhead-b5.ts     (from apps/api)
 *
 * NO DATABASE AND NO NETWORK, as in B4's harness: db/pool, services/s3,
 * services/sentry and @sendgrid/mail are replaced in require.cache before
 * email.ts loads, and the harness refuses to start with DATABASE_URL set.
 * Fake data on Star Guard's id; every address is @example.invalid or .example.
 * BASE is main before B5 (#105's merge), read from git and compiled under the
 * current path, so it sees the same stubs.
 *
 *   X  the instrument: BASE carries the <style> block, the current code none.
 *   P  N182, for all 18 renders: every element's inline declarations are,
 *      in order, what BASE's block and BASE's inline style gave that element
 *      (the block's rules by specificity, then source order, the inline style
 *      last). The page table carries the old body rule. Controls: Gmail's view
 *      of BASE (block dropped) differs in every template, and one declaration
 *      taken out is found.
 *   I  no <style> block and no class attribute, with or without a letterhead.
 *   T  BASE's subject and visible text, but for the listed rewrites, each as
 *      often as listed: day-first dates (admin alerts) and "— Do not reply to
 *      this email" (account emails).
 *   D  no day-first date in any email.
 *   A  admin alerts with Star Guard's letterhead, through their senders: the
 *      company block above the coloured band (D3a), no "NETRAOPS", "Powered by
 *      NetraOps", the logo inline, no Reply-To (D2a), one lookup per alert. A
 *      lookup that fails sends BASE's email; no admin, no lookup.
 *   W  account emails (D1a, D2a): the company's guard, secondary-admin and
 *      client welcomes carry its letterhead and send replies to it; the
 *      primary-admin welcome and the password reset stay NetraOps', with no
 *      lookup. No "Do not reply" anywhere. Under a letterhead each welcome is
 *      the company's own (N184): its subject, header and intro, and one
 *      contact line naming the footer's route (reply; else the primary admin;
 *      else NetraOps support).
 *   S  SendGrid refuses a letterhead message (400): each recipient gets one
 *      plain resend; other failures are reported as before.
 *   E  a poisoned profile is escaped in the company block and the footer.
 *   G  the guard welcome's "Get the NetraOps app" block (E1): the one URL, a button and
 *      a typed link with click tracking off, no store or platform named, a text/plain
 *      part and the click-tracking override on every send path (letterhead, no
 *      letterhead, plain resend after a 400), and no other email changed. The block is
 *      the one part of the guard welcome that is not BASE's, so P, T and W6 cut it out
 *      of both sides and keep pinning every other element and word.
 */
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { pngImage } from './image-fixtures';
import { APP_LINK_TEXT, WELCOME_APP_URL, appBlockHtml, appBlockText } from '../src/services/emailAppBlock';

/** main before B5: PR #105's merge. */
const BASE = 'c83ddc888e75af30bca0102713cc45d36e4c9f78';
const T0 = '2026-10-12T16:00:00Z';                      // 09:00 PDT
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const SITE = '0b5f0000-0000-4000-8000-0000000000a1';
const SHIFT = '0b5f0000-0000-4000-8000-0000000000b1';
const SESSION = '0b5f0000-0000-4000-8000-0000000000c1';
const VIOLATION = '0b5f0000-0000-4000-8000-0000000000d1';
const HISTORY = '0b5f0000-0000-4000-8000-0000000000e1';
const GUARD = '0b5f0000-0000-4000-8000-0000000000f1';
const ADMIN_ID = '0b5f0000-0000-4000-8000-000000000101';
const CREATOR_ID = '0b5f0000-0000-4000-8000-000000000102';
const CLIENT_ID = '0b5f0000-0000-4000-8000-000000000103';
const LOGO_URL = 'https://test-bucket.s3.us-east-1.amazonaws.com/company-logos/star-guard/logo';
const SUPPORT = 'support@netraops.com';
const POISON = `O'Brien & Sons <Site "A">`;
const ADMINS = ['ops.lead@example.invalid', 'night.desk@example.invalid'];
const TEMP = 'Tmp-Abc23xyz';

if (process.env.DATABASE_URL !== undefined) { console.error('REFUSING: DATABASE_URL must be unset.'); process.exit(2); }
process.env.SENDGRID_FROM_EMAIL = 'alerts@example.invalid';
process.env.SENDGRID_API_KEY = 'SG.stub';
process.env.CLIENT_PORTAL_URL = 'https://portal.example.invalid/client/';
process.env.S3_BUCKET = 'test-bucket';
process.env.AWS_REGION = 'us-east-1';
process.env.TZ = 'UTC';                                  // as Railway runs the API
delete process.env.SENTRY_DSN;

let failures = 0;
let passes = 0;
// A harness that stops before its last check must not pass.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.log('  ✗ FAIL: BEFOREEXIT the harness stopped before its last check (a promise never settled)');
    process.exitCode = 1;
  }
});
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }

const RealDate = Date;
async function frozen<T>(fn: () => Promise<T>, at = T0): Promise<T> {
  const t = RealDate.parse(at);
  function FrozenDate(...args: unknown[]): Date {
    return args.length === 0 ? new RealDate(t) : (Reflect.construct(RealDate, args) as Date);
  }
  FrozenDate.now = () => t;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.prototype = RealDate.prototype;
  (globalThis as { Date: unknown }).Date = FrozenDate;
  try { return await fn(); } finally { (globalThis as { Date: unknown }).Date = RealDate; }
}

function inject(request: string, exports: unknown): string {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
  return resolved;
}

const gitShow = (rel: string) => execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', `${BASE}:apps/api/${rel}`], { encoding: 'utf8' });

/** `apps/api/<rel>` as it was at BASE, compiled under the current path; not cached. */
function loadBase(rel: string): any {
  const file = path.join(__dirname, '..', rel);
  const js = ts.transpileModule(gitShow(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}

// ── The world the stubs answer from ──────────────────────────────────────────
type Row = Record<string, unknown>;
type Msg = { to: unknown; from: unknown; replyTo?: unknown; subject: string; html: string; text?: string; trackingSettings?: unknown; attachments?: Array<Record<string, unknown>> };
interface World {
  company: Row | null | 'throw';
  admins: string[];
  /** The company's active primary admin, as the welcome senders read it. */
  primaryAdmin: string | null;
  logo: Buffer;
  /** 'ok', or the status SendGrid rejects this message with. */
  sendgrid: (msg: Msg) => 'ok' | number;
}

const T = (s: string) => new RealDate(s);
const FULL_ROW: Row = {
  id: STAR_GUARD, name: 'Star Guard', contact_email: 'dispatch@starguard.example', phone: '(510) 555-0142',
  address: '4100 Mowry Ave, Ste 12,\nFremont, CA 94538', licence_number: 'PPO 120456',
  website: 'https://www.starguard.example/', logo_url: LOGO_URL, logo_updated_at: '2026-10-12T10:00:00Z',
};
const LOGO = pngImage(400, 160);
const PLAZA = { site_name: 'Harbor Point Plaza', site_tz: 'America/Los_Angeles' };
const MISSED_ROW: Row = {
  id: SHIFT, scheduled_start: T('2026-10-12T15:45:00Z'), scheduled_end: T('2026-10-12T23:45:00Z'), guard_id: GUARD, ...PLAZA,
  site_address: '100 Harbor Way, Oakland, CA', guard_name: 'alex rivera', badge_number: 'GRD9001', guard_phone: '+1 510 555 0199',
  client_email: null, company_id: STAR_GUARD, last_login_at: T('2026-10-12T12:00:00Z'), upcoming_shifts_count: '1',
};
const BREACH_ROW: Row = {
  id: VIOLATION, violation_lat: 37.8044, violation_lng: -122.2712, occurred_at: T('2026-10-12T15:31:00Z'),
  photo_url: 'https://media.example.invalid/p.jpg', shift_session_id: SESSION, ...PLAZA, site_address: '100 Harbor Way, Oakland, CA',
  center_lat: 37.8, center_lng: -122.27, guard_name: 'alex rivera', badge_number: 'GRD9001', client_email: null, company_id: STAR_GUARD,
};
const SWAP_ROW: Row = {
  id: HISTORY, shift_id: SHIFT, reason: 'Family appointment', scheduled_start: T('2026-10-12T15:00:00Z'), scheduled_end: T('2026-10-12T23:00:00Z'),
  ...PLAZA, from_guard_name: 'alex rivera', from_badge: 'GRD9001', to_guard_name: 'sam ortiz', to_badge: 'GRD9002', company_id: STAR_GUARD, is_same_site: true,
};
const HANDOFF_ROW: Row = {
  history_id: HISTORY, shift_id: SHIFT, reason: 'Feeling unwell', accepted_at: T('2026-10-12T15:10:00Z'), handoff_at: T('2026-10-12T15:40:00Z'),
  duration_hours: 2.5, from_guard_name: 'alex rivera', from_badge: 'GRD9001', to_guard_name: 'sam ortiz', to_badge: 'GRD9002', ...PLAZA, company_id: STAR_GUARD,
};
const post = (id: string, site: string): Row => ({
  id, site_id: site, site_name: 'Harbor Point Plaza', site_address: '100 Harbor Way, Oakland, CA', site_tz: 'America/Los_Angeles',
  scheduled_start: T('2026-10-12T16:50:00Z'), scheduled_end: T('2026-10-13T00:50:00Z'),
});

function world(over: Partial<World> = {}): World {
  return { company: FULL_ROW, admins: ADMINS, primaryAdmin: ADMINS[0], logo: LOGO, sendgrid: () => 'ok', ...over };
}
let W: World = world();
let stamp = 0;
/** A new logo_updated_at per scenario, so the logo cache never carries one over. */
function fresh(row: Row): Row {
  stamp += 1;
  return row.logo_url ? { ...row, logo_updated_at: new RealDate(RealDate.parse('2026-10-12T10:00:00Z') + stamp * 1000).toISOString() } : row;
}

const sqlLog: Array<{ text: string; params: unknown[] }> = [];
const s3Calls: string[] = [];
const attempts: Msg[] = [];
const delivered: Msg[] = [];
const sentry: Array<{ kind: 'message' | 'exception'; what: unknown; ctx: any }> = [];
const flat = (q: string) => q.replace(/\s+/g, ' ');
const isLookupSql = (q: string) => /FROM companies c WHERE c\.id = \$1/.test(flat(q));

inject('../src/db/pool', {
  pool: {
    async query(text: string, params: unknown[] = []) {
      const q = flat(String(text));
      sqlLog.push({ text: q, params });
      if (isLookupSql(q)) {
        if (W.company === 'throw') throw new Error('stub: database unavailable');
        return { rows: W.company ? [W.company] : [] };
      }
      if (/^SELECT email FROM company_admins WHERE company_id = \$1/.test(q.trim())) return { rows: W.admins.map((email) => ({ email })) };
      if (/FROM shifts sh JOIN sites si ON si\.id = sh\.site_id JOIN guards g/.test(q)) return { rows: [MISSED_ROW] };
      if (/^UPDATE shifts SET missed_alert_sent_at/.test(q.trim())) return { rows: [], rowCount: 1 };
      if (/FROM geofence_violations v/.test(q)) return { rows: [BREACH_ROW] };
      if (/FROM shift_swap_requests ssr/.test(q) && /is_same_site/.test(q)) return { rows: [SWAP_ROW] };
      if (/FROM shift_swap_requests ssr/.test(q) && /duration_hours/.test(q)) return { rows: [HANDOFF_ROW] };
      if (/creator\.name AS creator_name/.test(q)) return { rows: [{ company_name: 'Star Guard', creator_name: 'chris doe', primary_admin_email: W.primaryAdmin }] };
      if (/SELECT co\.name AS company_name, ca\.email AS primary_admin_email FROM companies co/.test(q)) return { rows: [{ company_name: 'Star Guard', primary_admin_email: W.primaryAdmin }] };
      if (/^SELECT name AS company_name FROM companies WHERE id = \$1/.test(q.trim())) return { rows: [{ company_name: 'Star Guard' }] };
      if (/^SELECT name FROM sites WHERE id = ANY/.test(q.trim())) return { rows: [{ name: 'Harbor Point Plaza' }] };
      throw new Error('unexpected SQL in the B5 harness: ' + q.slice(0, 90));
    },
  },
});
class S3ObjectTooLargeError extends Error {}
inject('../src/services/s3', {
  S3ObjectTooLargeError,
  s3KeyFromPublicUrl: (u: string) => (u === LOGO_URL ? 'company-logos/star-guard/logo' : null),
  async getS3ObjectBuffer(key: string) {
    s3Calls.push(key);
    return Buffer.from(W.logo);
  },
});
inject('../src/services/sentry', {
  Sentry: {
    captureMessage(what: unknown, ctx?: unknown) { sentry.push({ kind: 'message', what, ctx }); return 'evt'; },
    captureException(what: unknown, ctx?: unknown) { sentry.push({ kind: 'exception', what, ctx }); return 'evt'; },
    addBreadcrumb: () => undefined,
  },
  tagRequest: () => undefined,
});
const sgStub = {
  setApiKey(): void { /* stub */ },
  async send(msg: Msg): Promise<unknown> {
    attempts.push(msg);
    const r = W.sendgrid(msg);
    if (r !== 'ok') { const e = new Error(`stub ${r}`) as Error & { code: number }; e.code = r; throw e; }
    delivered.push(msg);
    return [{ statusCode: 202 }, {}];
  },
};
const SENDGRID = inject('@sendgrid/mail', { __esModule: true, default: sgStub });

/* eslint-disable @typescript-eslint/no-var-requires */
const CUR = require('../src/services/email');
const LH = require('../src/services/letterhead');
const LHE_PATH = require.resolve('../src/services/letterhead/email');
const LHE = require(LHE_PATH);
const { ES } = require('../src/services/emailStyles');
// BASE's email.ts runs with BASE's letterhead/email.ts: N182 inlined that
// file's footer too, so the current one would hide the change from P.
const BASE_LHE = loadBase('src/services/letterhead/email.ts');
const curLhe = require.cache[LHE_PATH];
inject(LHE_PATH, BASE_LHE);
const BASEMOD = loadBase('src/services/email.ts');
require.cache[LHE_PATH] = curLhe;
/* eslint-enable @typescript-eslint/no-var-requires */

/** Run `fn` against a clean slate: world, logs, logo cache, SendGrid failure state. */
async function run(over: Partial<World>, fn: (mod: any) => Promise<unknown>, mod: any = CUR, at = T0) {
  W = world(over);
  if (W.company && W.company !== 'throw') W.company = fresh(W.company);
  for (const a of [sqlLog, s3Calls, attempts, delivered, sentry] as unknown[][]) a.length = 0;
  LH.logoCache.clear();
  mod.__resetSendgridFailureState?.();
  let result: unknown;
  let error: unknown = null;
  try { result = await frozen(() => fn(mod), at); } catch (e) { error = e; }
  return {
    result, error,
    attempts: [...attempts], delivered: [...delivered], sentry: [...sentry], s3: [...s3Calls],
    lookups: sqlLog.filter((s) => isLookupSql(s.text)),
    stamped: sqlLog.filter((s) => /^\s*UPDATE shifts SET missed_alert_sent_at/.test(s.text)).length,
  };
}
const sentryNamed = <E extends { what: unknown }>(r: { sentry: E[] }, name: string): E[] => r.sentry.filter((e) => e.what === name);
const payload = (m: Msg | undefined) => JSON.stringify(m);
/** Everything but the html: addresses, subject, attachments. */
const envelope = (m: Msg | undefined) => JSON.stringify({ ...m, html: undefined });
/** E1: the guard welcome's app block is the one part that is not BASE's. Each side's block is cut out and
 *  replaced by the same marker, so P, T and W6 still pin every other element and word of that email. */
const BASE_APP_BLOCK = /<h3 [^>]*>Download the NetraOps app<\/h3>\s*<p [^>]*>iOS: [^<]*<\/p>\s*<p [^>]*>Android: [^<]*<\/p>/;
const CUR_APP_BLOCK = /<h3 [^>]*>Get the NetraOps app<\/h3>[\s\S]*?right app store for your phone\.<\/p>/;
const cutAppBlock = (html: string, re: RegExp) => html.replace(re, '<p style="margin:0">APP BLOCK</p>');
/** The message without what E1 adds to the guard welcome alone (the text part and the tracking override). */
const envelopeNoE1 = (m: Msg | undefined) => JSON.stringify({ ...m, html: undefined, text: undefined, trackingSettings: undefined });
/** The visible text: a <style> element's CSS is not text; tags out, whitespace collapsed. */
const visibleText = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const cidCount = (html: string) => html.split('cid:company-logo').length - 1;
const DAY_FIRST = /\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec) \d{4}\b/;

// ── P: the cascade BASE's block gave, against the inline styles ──────────────
type Decl = string;                                      // "property:value"
interface Part { tag: string | null; classes: string[] }
interface Rule { sel: Part[]; spec: number; order: number; decls: Decl[]; text: string }
interface El { tag: string; classes: string[]; style: Decl[]; parent: number }

function declarations(css: string): Decl[] {
  return css.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    if (i < 1) throw new Error(`not a declaration: ${d}`);
    return `${d.slice(0, i).trim().toLowerCase()}:${d.slice(i + 1).trim().replace(/\s+/g, ' ')}`;
  });
}
/** The block's rules. Only what BASE's block used: tags, classes, the descendant combinator. */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const text = m[1].trim();
    const sel = text.split(/\s+/).map((p): Part => {
      const mm = p.match(/^([a-z][a-z0-9]*)?((?:\.[A-Za-z0-9_-]+)*)$/);
      if (!mm || (!mm[1] && !mm[2])) throw new Error(`selector not handled: ${text}`);
      return { tag: mm[1] ?? null, classes: mm[2] ? mm[2].slice(1).split('.') : [] };
    });
    const spec = sel.reduce((s, p) => s + p.classes.length * 100 + (p.tag ? 1 : 0), 0);
    rules.push({ sel, spec, order: rules.length, decls: declarations(m[2]), text });
  }
  return rules;
}
const VOID = new Set(['br', 'img', 'hr', 'meta', 'input', 'link', 'col', 'area', 'base', 'wbr', 'source']);
/** Elements in document order, each with its parent; text and CSS skipped. */
function parseHtml(html: string): El[] {
  const els: El[] = [];
  const open: number[] = [];
  const src = html.replace(/(<style[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2');
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, close, t, attrs] = m;
    const tag = t.toLowerCase();
    if (close) {
      const k = open.map((i) => els[i].tag).lastIndexOf(tag);
      if (k < 0) throw new Error(`</${tag}> closes nothing`);
      open.length = k;
      continue;
    }
    const attr = (n: string) => attrs.match(new RegExp(`\\s${n}="([^"]*)"`))?.[1] ?? null;
    els.push({ tag, classes: (attr('class') ?? '').split(/\s+/).filter(Boolean), style: declarations(attr('style') ?? ''), parent: open.length ? open[open.length - 1] : -1 });
    if (!VOID.has(tag) && !attrs.trim().endsWith('/')) open.push(els.length - 1);
  }
  return els;
}
const partMatches = (p: Part, e: El) => (p.tag === null || p.tag === e.tag) && p.classes.every((c) => e.classes.includes(c));
function selectorMatches(sel: Part[], els: El[], i: number): boolean {
  if (!partMatches(sel[sel.length - 1], els[i])) return false;
  let k = sel.length - 2;
  for (let a = els[i].parent; k >= 0 && a >= 0; a = els[a].parent) if (partMatches(sel[k], els[a])) k -= 1;
  return k < 0;
}
/** What element `i` got from the block and its own style, in cascade order. */
function cascade(els: El[], rules: Rule[], i: number): { decls: Decl[]; fromBlock: boolean } {
  const hit = rules.filter((r) => selectorMatches(r.sel, els, i)).sort((a, b) => a.spec - b.spec || a.order - b.order);
  return { decls: [...hit.flatMap((r) => r.decls), ...els[i].style], fromBlock: hit.length > 0 };
}
/**
 * BASE's render against the current one, element by element from the card
 * down. `gmail` drops the block from BASE (what Gmail did with it).
 */
function compareStyles(base: string, cur: string, rules: Rule[], gmail = false): { compared: number; styled: number; problems: string[] } {
  const B = parseHtml(base);
  const C = parseHtml(cur);
  const problems: string[] = [];
  const bi = B.findIndex((e) => e.classes.includes('card'));
  const ci = 3;                                          // after the page's table, row and cell
  if (bi < 0) problems.push('BASE has no .card');
  if (C.length <= ci || C[ci].tag !== 'div') problems.push('the current render has no card after the page table');
  if (problems.length) return { compared: 0, styled: 0, problems };
  const n = B.length - bi;
  if (n !== C.length - ci) problems.push(`${n} elements from the card in BASE, ${C.length - ci} now`);
  let styled = 0;
  for (let k = 0; k < Math.min(n, C.length - ci); k += 1) {
    const b = B[bi + k];
    const c = C[ci + k];
    if (b.tag !== c.tag) { problems.push(`#${k} <${b.tag}> in BASE, <${c.tag}> now`); break; }
    const want = gmail ? { decls: b.style, fromBlock: false } : cascade(B, rules, bi + k);
    if (want.fromBlock) styled += 1;
    if (want.decls.join(';') !== c.style.join(';')) {
      problems.push(`#${k} <${b.tag}${b.classes.map((x) => '.' + x).join('')}>: BASE gave "${want.decls.join(';')}", now "${c.style.join(';')}"`);
    }
  }
  return { compared: Math.min(n, C.length - ci), styled, problems };
}

// ── Renders from fixed data (P, I, T, D) ─────────────────────────────────────
const PNG_MAIL = () => LHE.mailLetterhead({
  companyName: 'Star Guard', contactEmail: 'dispatch@starguard.example', phone: '(510) 555-0142',
  address: '4100 Mowry Ave, Ste 12\nFremont, CA 94538', licenceNumber: 'PPO 120456', website: 'https://www.starguard.example/', logo: LOGO,
});
const incidentData = { report_id: 'r1', description: 'Unlocked door at the north loading dock; secured.', severity: 'high', reported_at: T('2026-10-12T09:14:00Z'), ...PLAZA, client_name: 'jordan lee', company_name: 'Star Guard' };
const dailyData = {
  ...PLAZA, scheduled_start: T('2026-10-12T05:00:00Z'), guard_name: 'alex rivera', badge_number: 'GRD9001', client_name: 'jordan lee', company_name: 'Star Guard',
  clocked_in_at: T('2026-10-12T04:57:00Z'), clocked_out_at: T('2026-10-12T13:02:00Z'), total_hours: 8.08,
  hours: { scheduled_hours: 8, actual_hours: 8.08, break_hours: 0.5, violation_hours: 0 },
  reports: [
    { report_type: 'activity', severity: null, description: 'Patrol completed: all exterior doors locked.', reported_at: T('2026-10-12T06:30:00Z') },
    { report_type: 'incident', severity: 'high', description: 'Unlocked door at the north loading dock; secured.', reported_at: T('2026-10-12T09:14:00Z') },
  ],
  tasks_completed: 3, tasks_total: 4, pings_submitted: 15, pings_expected: 16,
};
const guardWelcome = { guard_name: 'alex rivera', guard_email: 'alex.rivera@example.invalid', company_name: 'Star Guard', primary_admin_email: ADMINS[0], temp_password: TEMP };
const primaryWelcome = { admin_name: 'pat lee', admin_email: 'pat.lee@example.invalid', company_name: 'Star Guard', temp_password: TEMP };
const secondaryWelcome = { ...primaryWelcome, creator_name: 'chris doe', primary_admin_email: ADMINS[0] };
const clientWelcome = { client_name: 'jordan lee', client_email: 'jordan.lee@example.invalid', company_name: 'Star Guard', site_names: 'Harbor Point Plaza', primary_admin_email: ADMINS[0], temp_password: TEMP };
const UNSTAFFED_NOW = T('2026-10-12T16:00:00Z');
const NO_REPLY = 'NetraOps — Do not reply to this email';
const dates = (n: number) => [{ from: '12 Oct 2026', to: 'Oct 12, 2026', times: n }];
const noReply = [{ from: NO_REPLY, to: 'NetraOps', times: 1 }];
type Rewrite = { from: string; to: string; times: number };
/**
 * N207 (after B5) added one paragraph to the password reset, under the password, which P, T and W7 cut out of the
 * current email (exactly once) before comparing it with BASE's; W7 checks the paragraph itself.
 */
const RESET_EXPIRY = /\n\s*<p style="color:#555;font-size:13px;margin-bottom:20px">\s*It works for 24 hours\.\s*<\/p>/;
function cutResetExpiry(html: string): string {
  if (html.split(RESET_EXPIRY).length !== 2) throw new Error('the password reset has no single "It works for 24 hours." paragraph');
  return html.replace(RESET_EXPIRY, '');
}
/** N207 (4a, after B5) rewrote the password reset's last line too. */
const resetRewrites: Rewrite[] = [...noReply, {
  from: "If you didn't request this, contact your administrator immediately.",
  to: "If you didn't ask for this, ignore this email: your current password still works.",
  times: 1,
}];
/** name → (render with a module, the rewrites BASE's visible text needs). */
const RENDERS: Array<[string, (E: any) => { subject: string; html: string }, Rewrite[]]> = [
  ['incident', (E) => E.renderIncidentAlert(incidentData), []],
  ['incident+letterhead', (E) => E.renderIncidentAlert(incidentData, PNG_MAIL()), []],
  ['daily', (E) => E.renderDailyShiftReport(dailyData), []],
  ['daily+letterhead', (E) => E.renderDailyShiftReport(dailyData, PNG_MAIL()), []],
  ['missed-shift', (E) => E.renderMissedShiftAlert(MISSED_ROW), dates(1)],
  ['unstaffed-1', (E) => E.renderUnstaffedPostWarning([post('a', 's1')], UNSTAFFED_NOW), dates(1)],
  ['unstaffed-3', (E) => E.renderUnstaffedPostWarning([post('a', 's1'), post('b', 's1'), post('c', 's2')], UNSTAFFED_NOW), dates(2)],
  ['breach-ping', (E) => E.renderGeofenceBreachAlert(BREACH_ROW, { kind: 'ping' }), dates(1)],
  ['breach-report', (E) => E.renderGeofenceBreachAlert(BREACH_ROW, { kind: 'report', reportType: 'incident' }), dates(1)],
  ['swap', (E) => E.renderSwapAcceptedFyi(SWAP_ROW), dates(2)],
  ['handoff-accepted', (E) => E.renderHandoffFyi(HANDOFF_ROW, 'accepted'), []],
  ['handoff-completed', (E) => E.renderHandoffFyi(HANDOFF_ROW, 'completed'), []],
  ['handoff-nudge', (E) => E.renderHandoffFyi(HANDOFF_ROW, 'nudge', 12), []],
  ['welcome-guard', (E) => E.renderGuardWelcome(guardWelcome), noReply],
  ['welcome-admin-primary', (E) => E.renderPrimaryAdminWelcome(primaryWelcome), noReply],
  ['welcome-admin-secondary', (E) => E.renderSecondaryAdminWelcome(secondaryWelcome), noReply],
  ['welcome-client', (E) => E.renderClientWelcome(clientWelcome), noReply],
];
/** The letterhead renders B5 added (no BASE counterpart). */
const LETTERED: Array<[string, () => { subject: string; html: string }]> = [
  ['missed-shift', () => CUR.renderMissedShiftAlert(MISSED_ROW, PNG_MAIL())],
  ['unstaffed-3', () => CUR.renderUnstaffedPostWarning([post('a', 's1'), post('b', 's1'), post('c', 's2')], UNSTAFFED_NOW, PNG_MAIL())],
  ['breach-ping', () => CUR.renderGeofenceBreachAlert(BREACH_ROW, { kind: 'ping' }, PNG_MAIL())],
  ['breach-report', () => CUR.renderGeofenceBreachAlert(BREACH_ROW, { kind: 'report', reportType: 'incident' }, PNG_MAIL())],
  ['swap', () => CUR.renderSwapAcceptedFyi(SWAP_ROW, PNG_MAIL())],
  ['handoff-accepted', () => CUR.renderHandoffFyi(HANDOFF_ROW, 'accepted', 0, PNG_MAIL())],
  ['handoff-completed', () => CUR.renderHandoffFyi(HANDOFF_ROW, 'completed', 0, PNG_MAIL())],
  ['handoff-nudge', () => CUR.renderHandoffFyi(HANDOFF_ROW, 'nudge', 12, PNG_MAIL())],
  ['welcome-guard', () => CUR.renderGuardWelcome(guardWelcome, PNG_MAIL())],
  ['welcome-admin-secondary', () => CUR.renderSecondaryAdminWelcome(secondaryWelcome, PNG_MAIL())],
  ['welcome-client', () => CUR.renderClientWelcome(clientWelcome, PNG_MAIL())],
];
/** The password reset builds its HTML inside the send: what each version sends. */
async function passwordReset(mod: any): Promise<Msg> {
  const r = await run({}, (E) => E.sendTempPasswordEmail('pat.lee@example.invalid', TEMP, 'admin'), mod);
  return r.delivered[0];
}

// ── The senders (A, W, S, E) ─────────────────────────────────────────────────
const ALERTS: Array<{ name: string; flow: string; send: (E: any) => Promise<unknown>; label: string | null; foot: string; dates: number }> = [
  { name: 'missed shift', flow: 'missed_shift_alert', send: (E) => E.sendMissedShiftAlert(SHIFT), label: 'ALERT', foot: 'Automated alert', dates: 1 },
  { name: 'unstaffed post', flow: 'unstaffed_post_warning', send: (E) => E.sendUnstaffedPostWarning(STAR_GUARD, [post('a', SITE), post('b', SITE)]), label: 'WARNING', foot: 'Automated warning', dates: 1 },
  { name: 'geofence breach', flow: 'geofence_breach_alert', send: (E) => E.sendGeofenceBreachAlert(VIOLATION, { kind: 'ping' }), label: 'ALERT', foot: 'Automated alert', dates: 1 },
  { name: 'coverage swap', flow: 'swap_accepted_fyi', send: (E) => E.sendSwapAcceptedFyi(HISTORY), label: null, foot: 'Automated alert', dates: 2 },
  { name: 'handoff accepted', flow: 'handoff_accepted_fyi', send: (E) => E.sendHandoffAcceptedFyi(HISTORY), label: null, foot: 'Automated alert', dates: 0 },
  { name: 'handoff completed', flow: 'handoff_completed_fyi', send: (E) => E.sendHandoffCompletedFyi(HISTORY), label: null, foot: 'Automated alert', dates: 0 },
  { name: 'handoff nudge', flow: 'handoff_nudge', send: (E) => E.sendHandoffNudgeFyi(HISTORY, 12), label: null, foot: 'Automated alert', dates: 0 },
];
/** N184 (Vishnu, 2026-10-13): the company's subject, header and intro; the body part each keeps. */
const WELCOMES: Array<{ name: string; to: string; subject: string; title: string; sub: string; hi: string; intro: string; keeps: string; send: (E: any) => Promise<unknown> }> = [
  { name: 'guard welcome', to: 'alex.rivera@example.invalid', subject: 'Welcome to Star Guard: your guard account', title: 'Welcome to Star Guard', sub: 'Guard account',
    hi: 'Hi Alex,', intro: 'Star Guard has created your guard account. You\'ll use the NetraOps app for your shifts.', keeps: 'Get the NetraOps app',
    send: (E) => E.sendGuardWelcomeEmail({ guard_id: GUARD, guard_name: 'alex rivera', guard_email: 'alex.rivera@example.invalid', company_id: STAR_GUARD, temp_password: TEMP }) },
  { name: 'secondary-admin welcome', to: 'pat.lee@example.invalid', subject: 'Star Guard: your admin account', title: 'Your admin account', sub: 'Admin portal',
    hi: 'Hi Pat,', intro: 'chris doe has made you an admin of Star Guard.', keeps: 'Access the admin portal app.netraops.com/admin',
    send: (E) => E.sendSecondaryAdminWelcomeEmail({ admin_id: ADMIN_ID, admin_name: 'pat lee', admin_email: 'pat.lee@example.invalid', company_id: STAR_GUARD, creator_admin_id: CREATOR_ID, temp_password: TEMP }) },
  { name: 'client welcome', to: 'jordan.lee@example.invalid', subject: 'Star Guard: your client portal account', title: 'Welcome to your client portal', sub: 'Harbor Point Plaza',
    hi: 'Hi Jordan,', intro: 'Star Guard has set up a client portal account for you. Sign in to see live guard activity, daily shift reports, incident reports and geofence alerts for your sites.',
    keeps: 'Sign in at app.netraops.com/client',
    send: (E) => E.sendClientWelcomeEmail({ client_id: CLIENT_ID, client_name: 'jordan lee', client_email: 'jordan.lee@example.invalid', company_id: STAR_GUARD, site_ids: [SITE], temp_password: TEMP }) },
];
const NETRAOPS_ONLY: Array<{ name: string; rw: Rewrite[]; cut?: (html: string) => string; send: (E: any) => Promise<unknown> }> = [
  { name: 'primary-admin welcome', rw: noReply, send: (E) => E.sendPrimaryAdminWelcomeEmail({ admin_id: ADMIN_ID, admin_name: 'pat lee', admin_email: 'pat.lee@example.invalid', company_id: STAR_GUARD, temp_password: TEMP }) },
  { name: 'password reset', rw: resetRewrites, cut: cutResetExpiry, send: (E) => E.sendTempPasswordEmail('pat.lee@example.invalid', TEMP, 'admin') },
];
const FULL_LINES = ['4100 Mowry Ave, Ste 12, Fremont, CA 94538', 'License No. PPO 120456'];
/** BASE's visible text with the rewrites applied, each counted. */
function rewritten(text: string, list: Rewrite[]): { text: string; problems: string[] } {
  const problems: string[] = [];
  for (const r of list) {
    const n = text.split(r.from).length - 1;
    if (n !== r.times) problems.push(`${JSON.stringify(r.from)} x${n}, expected x${r.times}`);
    text = text.split(r.from).join(r.to);
  }
  return { text, problems };
}

async function main(): Promise<void> {
  section('X — the instrument');
  const baseSrc = gitShow('src/services/email.ts');
  const block = baseSrc.match(/export const BASE_STYLE = `([\s\S]*?)`;/)?.[1] ?? '';
  const rules = parseRules(block);
  const code = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const cur = code('src/services/email.ts') + code('src/services/letterhead/email.ts');
  check(rules.length === 15 && (baseSrc.match(/class="/g) ?? []).length === 81 && !/class="/.test(cur) && !/<style/.test(cur),
    `X1 BASE (#105) has the block (${rules.length} rules) and 81 class attributes; the current email code has neither`);
  check(require.cache[SENDGRID]?.exports.default === sgStub && BASEMOD.BASE_STYLE === block
    && BASEMOD.renderIncidentAlert(incidentData, PNG_MAIL()).html.includes('<div class="footer" style=') && require(LHE_PATH) === LHE,
    'X2 both versions send through the SendGrid stub; the cascade reads BASE\'s block; BASE renders with BASE\'s letterhead footer');

  section('P — N182: every element gets what BASE\'s block and style gave it');
  const pr = await passwordReset(CUR);
  const prBase = await passwordReset(BASEMOD);
  const pairs: Array<[string, string, string, Rewrite[], string, string]> = await frozen(async () => RENDERS.map(([name, fn, rw]) => {
    const b = fn(BASEMOD);
    const c = fn(CUR);
    const cut = name === 'welcome-guard';
    return [name, cut ? cutAppBlock(b.html, BASE_APP_BLOCK) : b.html, cut ? cutAppBlock(c.html, CUR_APP_BLOCK) : c.html, rw, b.subject, c.subject];
  }));
  const lettered = await frozen(async () => LETTERED.map(([name, fn]) => [name, fn()] as const));
  pairs.push(['password-reset', prBase.html, cutResetExpiry(pr.html), resetRewrites, prBase.subject, pr.subject]);
  let gmailSame = 0;
  for (const [name, b, c] of pairs) {
    const r = compareStyles(b, c, rules);
    check(r.problems.length === 0 && r.compared > 10 && r.styled > 3,
      `P ${name}: ${r.compared} elements, ${r.styled} styled by the block; every one's declarations are BASE's${r.problems.length ? ` (${r.problems.slice(0, 3).join(' | ')})` : ''}`);
    if (compareStyles(b, c, rules, true).problems.length === 0) gmailSame += 1;
  }
  check(gmailSame === 0, `P-control Gmail's view of BASE (the block dropped) differs from now in ${pairs.length - gmailSame} of ${pairs.length} templates`);
  {
    const [, b, c] = pairs.find(([n]) => n === 'missed-shift')!;
    const doctored = c.replace(`style="${ES.body}"`, `style="${ES.body.replace('padding:24px 28px', '')}"`);
    const r = compareStyles(b, doctored, rules);
    check(doctored !== c && r.problems.length === 1 && /^#\d+ <div\.body>/.test(r.problems[0]),
      'P-control one declaration taken out of one element is found, on that element alone');
    const bodyRule = rules.find((x) => x.text === 'body')!.decls;
    const decl = (prop: string) => bodyRule.find((d) => d.startsWith(`${prop}:`));
    const pageOk = pairs.every(([, , cur]) => {
      const C = parseHtml(cur);
      return C[0].tag === 'table' && C[1].tag === 'tr' && C[2].tag === 'td'
        && C[0].style.join(';') === `${decl('background')};${decl('font-family')}` && C[2].style.join(';') === decl('padding');
    });
    check(pageOk, 'P-page every email sits in a table carrying the body rule\'s background and font, and a cell with its 20 px (the body\'s own margin is the mail client\'s)');
  }

  section('I — no <style> block and no class attribute');
  {
    const all = [...pairs.map(([n, , c]) => [n, c]), ...lettered.map(([n, r]) => [`${n}+letterhead`, r.html])];
    const bad = all.filter(([, h]) => /<style[\s>]/i.test(h) || /\sclass="/.test(h)).map(([n]) => n);
    check(all.length === 29 && bad.length === 0, `I1 ${all.length} renders, none with a <style> block or a class attribute${bad.length ? ` (${bad.join(', ')})` : ''}`);
  }

  section('T — BASE\'s subject and visible text, but for the listed rewrites');
  for (const [name, b, c, rw, bs, cs] of pairs) {
    const want = rewritten(visibleText(b), rw);
    check(want.problems.length === 0 && want.text === visibleText(c) && bs === cs,
      `T ${name}: ${rw.length ? rw.map((r) => `"${r.from}" → "${r.to}" x${r.times}`).join(', ') : 'no rewrite'}; the subject unchanged${want.problems.length ? ` (${want.problems.join('; ')})` : ''}`);
  }
  check(payload({ ...prBase, html: '' }) === payload({ ...pr, html: '' }), 'T password reset: addresses, Reply-To and subject unchanged');

  section('D — no day-first date in any email');
  {
    const all = [...pairs.map(([n, , c, , , s]) => [n, s + c]), ...lettered.map(([n, r]) => [`${n}+letterhead`, r.subject + r.html])];
    const left = all.filter(([, t]) => DAY_FIRST.test(t)).map(([n, t]) => `${n}: ${t.match(DAY_FIRST)?.[0]}`);
    check(left.length === 0, `D1 ${all.length} renders, subjects included, carry no day-first date${left.length ? ` (${left.join(', ')})` : ''}`);
    const want: Record<string, string> = {
      'missed-shift': 'Oct 12, 2026, 8:45 AM PDT → 4:45 PM PDT', 'breach-ping': 'Oct 12, 2026, 8:31 AM PDT',
      'swap': 'Harbor Point Plaza · Oct 12, 2026', 'unstaffed-1': 'Oct 12, 2026, 9:50 AM PDT → 5:50 PM PDT',
    };
    const miss = Object.entries(want).filter(([n, s]) => !visibleText(pairs.find(([p]) => p === n)![2]).includes(s)).map(([n]) => n);
    check(miss.length === 0, `D2 the admin alerts print "Oct 12, 2026" in the site's zone${miss.length ? ` (missing in ${miss.join(', ')})` : ''}`);
  }

  section('A — admin alerts with Star Guard\'s letterhead, through their senders');
  for (const a of ALERTS) {
    const r = await run({}, a.send);
    const [m1, m2] = r.delivered;
    const html = m1?.html ?? '';
    const company = html.indexOf('>Star Guard</div>');
    const band = html.indexOf('<h1 ');
    check(r.delivered.length === 2 && m1?.to === ADMINS[0] && m2?.to === ADMINS[1]
      && r.delivered.every((m) => !('replyTo' in m) && m.attachments?.length === 1 && m.attachments[0].content_id === 'company-logo'
        && m.attachments[0].disposition === 'inline' && Buffer.from(String(m.attachments[0].content), 'base64').equals(LOGO) && cidCount(m.html) === 1),
      `A1 ${a.name}: one message per admin; each has the logo inline (one cid) and no Reply-To`);
    check(company > 0 && band > company && FULL_LINES.every((l) => html.includes(`>${l}</div>`) && html.indexOf(l) < band)
      && !html.includes('NETRAOPS') && (a.label === null || html.includes(`>${a.label}</div>`)),
      `A2 ${a.name}: the company block leads, above the band${a.label ? `; the band says ${a.label}` : '; no brand line'}; no "NETRAOPS"`);
    check(html.includes(`${a.foot}${LHE.POWERED_BY_HTML}`) && !html.includes('NetraOps · Automated'),
      `A3 ${a.name}: the footer ends "${a.foot}" and "Powered by NetraOps"`);
    check(r.lookups.length === 1 && r.lookups[0].params[0] === STAR_GUARD && r.s3.length === 1,
      `A4 ${a.name}: one lookup (Star Guard's id) and one S3 fetch for both admins`);
    const failed = await run({ company: 'throw' }, a.send);
    const base = await run({ company: 'throw' }, a.send, BASEMOD);
    const rw = a.dates ? dates(a.dates) : [];
    const ok = failed.delivered.length === 2 && base.delivered.length === 2 && failed.delivered.every((m, i) => {
      const want = rewritten(visibleText(base.delivered[i].html), rw);
      return want.problems.length === 0 && envelope(m) === envelope(base.delivered[i]) && visibleText(m.html) === want.text;
    });
    check(ok && sentryNamed(failed, 'letterhead_lookup_failed').length === 1,
      `A5 ${a.name}: a lookup that fails sends BASE's email (addresses, subject, visible text${rw.length ? ', dates rewritten' : ''}), a Sentry warning once`);
    if (a.name === 'missed shift') {
      check(r.stamped === 1 && failed.stamped === 1, 'A6 missed shift: stamped once after the sends, with a letterhead or without');
    }
  }
  {
    const none = await run({ admins: [] }, ALERTS[0].send);
    const unstaffed = await run({ admins: [] }, ALERTS[1].send);
    check(none.lookups.length === 0 && none.attempts.length === 0 && sentryNamed(none, 'sendMissedShiftAlert: no active admins for tenant').length === 1
      && unstaffed.lookups.length === 0 && unstaffed.attempts.length === 0,
      'A7 no active admin: no lookup, no send, the warning as before');
    const empty = await run({ company: { ...FULL_ROW, contact_email: null, phone: null, address: null, licence_number: null, website: null, logo_url: null, logo_updated_at: null } }, ALERTS[0].send);
    const m = empty.delivered[0];
    check(m !== undefined && !m.attachments && cidCount(m.html) === 0 && !('replyTo' in m) && m.html.includes('>Star Guard</div>') && empty.s3.length === 0,
      'A8 an empty profile: the company name alone above the band, no logo, no Reply-To');
  }

  section('W — account emails (D1a, D2a, N184)');
  for (const w of WELCOMES) {
    const r = await run({}, w.send);
    const m = r.delivered[0];
    const html = m?.html ?? '';
    check(r.delivered.length === 1 && m?.to === w.to && html.includes('>Star Guard</div>') && FULL_LINES.every((l) => html.includes(`>${l}</div>`))
      && html.includes(`>${w.title}</h1>`) && html.includes(`>${w.sub}</p>`) && !html.includes('>WELCOME</h1>') && !html.includes('>NetraOps</div>'),
      `W1 ${w.name}: Star Guard's header ("${w.title}", "${w.sub}") replaces NetraOps'`);
    check(html.includes('Provided by <strong style="color:#666">Star Guard</strong>.') && html.includes('Reply to this email to contact Star Guard.')
      && html.includes('Powered by NetraOps') && !html.includes('time zone'),
      `W2 ${w.name}: the footer says who sent it, that replies reach Star Guard, "Powered by NetraOps"; no time zone line`);
    check(m?.replyTo === 'dispatch@starguard.example' && m?.attachments?.length === 1 && m.attachments[0].content_id === 'company-logo' && cidCount(html) === 1
      && r.lookups.length === 1 && r.lookups[0].params[0] === STAR_GUARD,
      `W3 ${w.name}: Reply-To the company's contact email; the logo inline; one lookup for Star Guard`);
    const base = await run({}, w.send, BASEMOD);
    const text = visibleText(html);
    const questions = (t: string) => t.split('Questions?').length - 1;
    check(m?.subject === w.subject && text.includes(`${w.hi} ${w.intro}`) && !text.includes('Welcome to NetraOps')
      && text.includes('Login credentials Email:') && text.includes(`Temporary password: ${TEMP}`) && text.includes(w.keeps),
      `W4 ${w.name} (N184): subject "${w.subject}"; "${w.hi}" and the intro; no "Welcome to NetraOps"; the sign-in details and "${w.keeps}" kept`);
    check(questions(text) === 1 && text.includes('Questions? Reply to this email to reach Star Guard.'),
      `W5 ${w.name} (N184): one contact line, "reply" — the route the footer names`);
    const noContact = await run({ company: { ...FULL_ROW, contact_email: null } }, w.send);
    const nm = noContact.delivered[0];
    const nt = visibleText(nm?.html ?? '');
    check(nm?.replyTo === SUPPORT && !nm.html.includes('Reply to this email') && nm.attachments?.length === 1
      && questions(nt) === 1 && (nm?.html ?? '').includes(`Questions? Contact Star Guard at <a href="mailto:${ADMINS[0]}" style="color:#F59E0B">${ADMINS[0]}</a>.`),
      `W5b ${w.name}: no contact email: Reply-To ${SUPPORT}, no reply line; the contact line names the primary admin`);
    const nobody = await run({ company: { ...FULL_ROW, contact_email: null }, primaryAdmin: null }, w.send);
    const bt = visibleText(nobody.delivered[0]?.html ?? '');
    check(nobody.delivered[0]?.replyTo === SUPPORT && questions(bt) === 1
      && (nobody.delivered[0]?.html ?? '').includes(`Questions? Contact NetraOps support at <a href="mailto:${SUPPORT}" style="color:#F59E0B">${SUPPORT}</a>.`),
      `W5c ${w.name}: no contact email and no primary admin: the contact line names NetraOps support, where the Reply-To goes`);
    const failed = await run({ company: 'throw' }, w.send);
    const fm = failed.delivered[0];
    const g = w.name === 'guard welcome';
    const want = base.delivered[0] && rewritten(visibleText(g ? cutAppBlock(base.delivered[0].html, BASE_APP_BLOCK) : base.delivered[0].html), noReply);
    check(fm !== undefined && want !== undefined && want.problems.length === 0 && (g ? envelopeNoE1 : envelope)(fm) === (g ? envelopeNoE1 : envelope)(base.delivered[0])
      && visibleText(g ? cutAppBlock(fm.html, CUR_APP_BLOCK) : fm.html) === want.text && fm.replyTo === SUPPORT,
      `W6 ${w.name}: a lookup that fails sends BASE's email but for "${NO_REPLY}" → "NetraOps"`);
  }
  for (const n of NETRAOPS_ONLY) {
    const r = await run({}, n.send);
    const m = r.delivered[0];
    const base = await run({}, n.send, BASEMOD);
    const want = base.delivered[0] && rewritten(visibleText(base.delivered[0].html), n.rw);
    check(r.lookups.length === 0 && m !== undefined && m.replyTo === SUPPORT && !m.attachments && m.html.includes(`<div style="${ES.brand}">NetraOps</div>`)
      && want !== undefined && want.problems.length === 0 && envelope(m) === envelope(base.delivered[0]) && visibleText(n.cut ? n.cut(m.html) : m.html) === want.text,
      `W7 ${n.name}: NetraOps', with no letterhead lookup, even for a company with one; BASE's email but for ${n.rw.map((x) => `"${x.from}"`).join(' and ')}${n.cut ? ', and N207\'s paragraph under the password' : ''}`);
    if (n.cut) {
      const html = m?.html ?? '';
      const box = html.indexOf(TEMP);
      const para = html.search(RESET_EXPIRY);
      check(box > 0 && para > box && html.indexOf('</div>', box) + '</div>'.length === para && para < html.indexOf('You will be required to change this on next login.'),
        `W7b ${n.name}: N207's one paragraph, "It works for 24 hours.", sits right under the password and above "You will be required to change this on next login."`);
    }
  }
  {
    const everything: string[] = [];
    for (const w of [...WELCOMES, ...NETRAOPS_ONLY]) {
      for (const over of [{}, { company: 'throw' as const }, { company: { ...FULL_ROW, contact_email: null } }]) {
        everything.push(...(await run(over, w.send)).delivered.map((m) => m.html));
      }
    }
    check(everything.length === 15 && everything.every((h) => !h.includes('Do not reply')), `W8 "Do not reply" is gone from all ${everything.length} account emails sent`);
  }

  section('G — the guard welcome\'s app block (E1)');
  {
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    const NO_CLICK = JSON.stringify({ clickTracking: { enable: false, enableText: false } });
    // The three ways this email is really sent: with the letterhead; without it (lookup failed); and the
    // plain resend after SendGrid refuses the letterhead message (400).
    const sent: Array<[string, Msg | undefined]> = [
      ['lettered', (await run({}, WELCOMES[0].send)).delivered[0]],
      ['no letterhead', (await run({ company: 'throw' }, WELCOMES[0].send)).delivered[0]],
      ['plain resend after a 400', (await run({ sendgrid: (m: Msg) => (m.attachments ? 400 : 'ok') }, WELCOMES[0].send)).delivered[0]],
    ];
    // Brand names are case-sensitive: the block says "the right app store", a generic noun, on purpose.
    const NAMES = /App Store|Play Store|Google Play|Android|iOS|iPhone|Coming to|Download the NetraOps app/;
    // Widened to string: the constant's literal type would turn a wrong tag into a compile error (TS2367) instead of this failure.
    check((WELCOME_APP_URL as string) === 'https://www.netraops.com/app?src=welcome_email',
      'G1 the URL is the owner\'s one URL with the registered tag: https://www.netraops.com/app?src=welcome_email');
    for (const [label, m] of sent) {
      const html = m?.html ?? '';
      check(m !== undefined && html.includes(appBlockHtml()) && count(html, `href="${WELCOME_APP_URL}"`) === 2 && count(html, 'clicktracking="off"') === 2
        && html.includes('>GET THE APP</a>') && html.includes(`>${APP_LINK_TEXT}</a>`) && count(html, '<h3 ') === 2,
        `G2 ${label}: the block is there once: a button and a typed link to the one URL, both with click tracking off`);
      check(!NAMES.test(html) && !/testflight/i.test(html) && !NAMES.test(m?.text ?? '') && !/testflight/i.test(m?.text ?? ''),
        `G3 ${label}: no store, platform, TestFlight or "Coming soon" wording anywhere in the email`);
      check(html.includes('bgcolor="#F59E0B"') && html.includes('mso-padding-alt:16px 32px') && html.includes('padding:16px 32px')
        && html.includes('color:#0B1526') && !/\sclass="/.test(html) && !/<style[\s>]/i.test(html) && !/<img /i.test(appBlockHtml()),
        `G4 ${label}: an amber button, navy text, padding 16/32 (mso-padding-alt too); inline styles only; no image in the block`);
      const text = m?.text ?? '';
      const lines = text.split('\n');
      check(typeof m?.text === 'string' && lines.includes(WELCOME_APP_URL) && lines.includes('Open this link on your phone:')
        && appBlockText().every((l) => lines.includes(l)) && text.includes(`Temporary password: ${TEMP}`) && text.endsWith('\n')
        && !/[<>]|&amp;|&lt;/.test(text),
        `G5 ${label}: a text/plain part: the URL alone on its own line, the credentials, no markup`);
      check(NO_CLICK === JSON.stringify(m?.trackingSettings),
        `G6 ${label}: SendGrid click tracking is off for the message (the override travels on every send path)`);
    }
    check(sent.every(([, m]) => !!m?.text) && appBlockText().every((l) => l.length <= 78),
      'G7 every line of the text block is 78 characters or fewer');
    check(/^[\x20-\x7E\n]*$/.test(appBlockHtml() + appBlockText().join('\n') + WELCOME_APP_URL),
      'G8 the block (markup and text) is ASCII: a non-ASCII character in this message is a clip candidate (N185)');
    check(!/&/.test(appBlockHtml()) && !/&/.test(appBlockText().join('\n')),
      'G9 no "&" in the block: the URL has one query parameter, and a bare & is what check-email-escaping rejects');

    // The text part says what the HTML says: the same contact route, in each of the three worlds.
    const worlds: Array<[string, Partial<World>, string]> = [
      ['reply (company contact email)', {}, 'Questions? Reply to this email to reach Star Guard.'],
      ['primary admin', { company: { ...FULL_ROW, contact_email: null } }, `Questions? Contact Star Guard at ${ADMINS[0]}.`],
      ['NetraOps support', { company: { ...FULL_ROW, contact_email: null }, primaryAdmin: null }, `Questions? Contact NetraOps support at ${SUPPORT}.`],
    ];
    const stripTags = (h: string) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    for (const [label, over, sentence] of worlds) {
      const m = (await run(over, WELCOMES[0].send)).delivered[0];
      check(stripTags(m?.html ?? '').includes(sentence) && (m?.text ?? '').split('\n').includes(sentence),
        `G10 ${label}: the HTML and the text part name the same contact route ("${sentence}")`);
    }
    const noLetterhead = (await run({ company: 'throw' }, WELCOMES[0].send)).delivered[0];
    check((noLetterhead?.text ?? '').includes(`Questions? Contact your Company Admin: ${ADMINS[0]}`) && visibleText(noLetterhead?.html ?? '').includes(`Questions? Contact your Company Admin: ${ADMINS[0]}`),
      'G11 no letterhead: the HTML and the text part both name the Company Admin');

    // Text is not HTML: a name with markup characters is escaped once in the HTML and printed raw in the text,
    // and a name with a line break stays on one line.
    const data = { guard_name: POISON, guard_email: 'x@example.invalid', company_name: POISON, primary_admin_email: null, temp_password: TEMP };
    const plainR = CUR.renderGuardWelcome(data);
    const lettR = CUR.renderGuardWelcome(data, PNG_MAIL());
    const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const htmlGreeting = /Hi ([^,]+),/.exec(stripTags(lettR.html))?.[1] ?? '';
    check(plainR.text.includes(`Hi ${POISON},`) && plainR.text.includes(`by ${POISON}.`) && !/&amp;|&lt;|&quot;/.test(plainR.text)
      && htmlGreeting !== '' && lettR.text.includes(`Hi ${unesc(htmlGreeting)},`) && !/&amp;|&lt;|&quot;/.test(lettR.text),
      'G12 a poisoned name is raw in the text part (it is not HTML) and still escaped once in the HTML');
    check(plainR.html.includes('&amp;') && !plainR.html.includes('&amp;amp;') && !/<Site/.test(plainR.html),
      'G13 ...and the HTML of the same render is escaped once');
    const split = CUR.renderGuardWelcome({ ...data, guard_name: 'Ana\nBell\r\nOps', company_name: 'Co\nName' });
    check(split.text.includes('Hi Ana Bell Ops,') && split.text.includes('by Co Name.') && !/Ana\nBell/.test(split.text),
      'G14 a name or company with a line break stays on one line in the text part');

    // Nothing else changed: no other email gets a text part, a tracking override or the block.
    const others: Array<[string, Msg | undefined]> = [];
    for (const w of [...WELCOMES.slice(1), ...NETRAOPS_ONLY]) {
      for (const over of [{}, { company: 'throw' as const }]) others.push([w.name, (await run(over, w.send)).delivered[0]]);
    }
    check(others.length === 8 && others.every(([, m]) => m !== undefined && !('text' in m) && !('trackingSettings' in m) && !m.html.includes('src=welcome_email')),
      `G15 ${others.length} sends of the other account emails (secondary admin, client, primary admin, password reset), with and without a letterhead: no text part, no tracking override, no app block`);
  }

  section('S — SendGrid refuses a letterhead message');
  {
    const plain = await run({ company: 'throw' }, ALERTS[0].send);
    const refuse400 = (m: Msg) => (m.attachments ? 400 : 'ok');
    const r = await run({ sendgrid: refuse400 }, ALERTS[0].send);
    check(r.attempts.length === 4 && r.delivered.length === 2 && r.delivered.every((m, i) => payload(m) === payload(plain.delivered[i]))
      && r.stamped === 1 && !r.error,
      'S1 missed shift, 400 on the letterhead message: each admin gets one plain resend, byte-identical to the email with no letterhead; stamped');
    check(sentryNamed(r, 'letterhead_email_refused').length === 1 && sentryNamed(r, 'sendgrid_failing').length === 0,
      'S2 Sentry: letterhead_email_refused once for the alert, no sendgrid_failing');
    const one = await run({ sendgrid: (m: Msg) => (m.to === ADMINS[1] ? 400 : refuse400(m)) }, ALERTS[2].send, CUR, '2026-10-12T18:30:00Z');
    const fail = sentryNamed(one, 'sendgrid_failing');
    check(one.attempts.length === 4 && one.delivered.length === 1 && one.delivered[0].to === ADMINS[0] && !one.error
      && fail.length === 1 && fail[0].ctx?.tags?.status === '400' && fail[0].ctx?.tags?.flow === 'geofence_breach_alert',
      'S3 breach, one admin\'s resend refused too: the other is delivered; the failure reported as before (400)');
    const other = await run({ sendgrid: (m: Msg) => (m.attachments ? 429 : 'ok') }, ALERTS[0].send, CUR, '2026-10-12T21:00:00Z');
    check(other.attempts.length === 2 && other.delivered.length === 0 && other.stamped === 0 && other.error instanceof Error
      && /all 2 recipients failed/.test((other.error as Error).message),
      'S4 any other status (429): no resend; every admin failed, so the alert throws and is not stamped, as before');
    const w = await run({ sendgrid: refuse400 }, WELCOMES[2].send, CUR, '2026-10-12T23:00:00Z');
    check(w.attempts.length === 2 && w.delivered.length === 1 && !w.delivered[0].attachments && w.delivered[0].replyTo === SUPPORT && !w.error
      && sentryNamed(w, 'letterhead_email_refused')[0]?.ctx?.tags?.email_flow === 'welcome_client',
      'S5 client welcome, 400: one plain resend (Reply-To support@); letterhead_email_refused names the flow');
  }

  section('E — a poisoned profile is escaped');
  {
    const poisoned = { ...FULL_ROW, name: POISON, address: POISON, phone: POISON, website: POISON, licence_number: POISON };
    const esc = `O'Brien &amp; Sons &lt;Site &quot;A&quot;&gt;`;
    for (const [name, send] of [['missed shift', ALERTS[0].send], ['client welcome', WELCOMES[2].send]] as const) {
      const html = (await run({ company: poisoned }, send)).delivered[0]?.html ?? '';
      check(html.includes(`>${esc}</div>`) && html.includes(`License No. ${esc}`) && !html.includes('<Site') && !html.includes('&amp;amp;') && !html.includes('&amp;lt;'),
        `E1 ${name}: the name, address, phone, website and licence are escaped once`);
    }
    // email.ts escapes text nodes for &, < and > (quotes are safe there); the letterhead also escapes ".
    const escText = `O'Brien &amp; Sons &lt;Site "A"&gt;`;
    const welcome = (await run({ company: poisoned }, WELCOMES[2].send)).delivered[0];
    check(welcome?.subject === `${POISON}: your client portal account` && (welcome?.html ?? '').includes(`${escText} has set up a client portal account`)
      && (welcome?.html ?? '').includes(`Questions? Reply to this email to reach ${escText}.`),
      'E2 client welcome (N184): the company name is raw in the subject (text) and escaped once in the intro and the contact line');
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('  ✗ FAIL: CRASH', err);
  process.exitCode = 1;
  finished = true;
});
