/**
 * test-letterhead-b4.ts — the security company's letterhead on the two client
 * emails (Phase B, stage B4): the incident alert (#10) and the daily shift
 * report (#9), and their month-name dates.
 *
 *   npx ts-node -P tsconfig.scripts.json scripts/test-letterhead-b4.ts     (from apps/api)
 *
 * NO DATABASE AND NO NETWORK. db/pool, services/s3, services/sentry and
 * @sendgrid/mail are replaced in require.cache before email.ts loads, and the
 * harness refuses to start with DATABASE_URL set. Fake data on Star Guard's
 * id; every address is @example.invalid or .example. BASE is main before B4,
 * read from git and compiled under the current path, so it sees the same stubs.
 *
 *   A  no letterhead (the lookup fails, or finds no company): BASE's addresses
 *      and subject, and BASE's visible text, but for the dates, rewritten as
 *      listed, each as often as listed. The incident alert and the daily report.
 *      (Byte for byte until B5: N182 then inlined every style on purpose, and
 *      scripts/test-letterhead-b5.ts holds the look pixel-identical to BASE.)
 *   D  the dates: "Oct 12, 2026" in subjects and bodies, in the site's zone
 *      under a UTC and a Pacific process; no day-first date left. (D5, the
 *      other nine templates byte-identical to BASE, moved to B5's harness when
 *      B5 changed them on purpose.)
 *   L  Star Guard's full letterhead and logo: header, footer, Reply-To, one
 *      inline attachment (content_id, through the real @sendgrid/helpers), the
 *      logo box, a JPEG logo, one lookup per alert and per shift.
 *   N  N167: an empty profile; a corrupt PNG and JPEG; a missing logo; a logo
 *      over the 256 KB email cap (warned once) and one exactly at it; a slow
 *      logo (sent at ~2 s without it, then from the cache), while a PDF lookup
 *      still waits; a contact email SendGrid might refuse.
 *   E  a poisoned profile is escaped in the header and footer.
 *   S  SendGrid refuses a letterhead message (400): one plain resend, Sentry
 *      once an hour; a refused resend, another status, or no letterhead: no
 *      resend, reported as before.
 *   R  skips, recipients and flagging unchanged; no lookup for a skipped shift
 *      or an alert with no client; the lookup is for the right site.
 */
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { pngImage, pngPadded, pngCorruptAfterHeader, jpegImage, jpegCorruptAfterHeader } from './image-fixtures';

/** main before B4: PR #104's merge. */
const BASE = 'd6c8b7d6b89fcd615da8bac7ca61d32958653c12';
const T0 = '2026-10-12T16:00:00Z';                      // 09:00 PDT, when the daily job runs
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const SITE = '0b4f0000-0000-4000-8000-0000000000a1';
const SHIFT = '0b4f0000-0000-4000-8000-0000000000b1';
const SESSION = '0b4f0000-0000-4000-8000-0000000000c1';
const LOGO_URL = 'https://test-bucket.s3.us-east-1.amazonaws.com/company-logos/star-guard/logo';
const SUPPORT = 'support@netraops.com';
const POISON = `O'Brien & Sons <Site "A">`;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** `apps/api/<rel>` as it was at BASE, compiled under the current path; not cached. */
function loadBase(rel: string): any {
  const file = path.join(__dirname, '..', rel);
  const src = execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', `${BASE}:apps/api/${rel}`], { encoding: 'utf8' });
  const js = ts.transpileModule(src, {
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
type Msg = { to: unknown; from: unknown; replyTo: unknown; subject: string; html: string; attachments?: Array<Record<string, unknown>> };
interface World {
  company: Row | null | 'throw';
  clients: Array<{ name: string; email: string }>;
  shift: Row;
  logo: Buffer | 'missing';
  logoDelayMs: number;
  /** 'ok', or the status SendGrid rejects this message with. */
  sendgrid: (msg: Msg) => 'ok' | number;
}

const FULL_ROW: Row = {
  id: STAR_GUARD, name: 'Star Guard', contact_email: 'dispatch@starguard.example', phone: '(510) 555-0142',
  address: '4100 Mowry Ave, Ste 12,\nFremont, CA 94538', licence_number: 'PPO 120456',
  website: 'https://www.starguard.example/', logo_url: LOGO_URL, logo_updated_at: '2026-10-12T10:00:00Z',
};
const EMPTY_ROW: Row = {
  id: STAR_GUARD, name: 'Star Guard', contact_email: null, phone: null, address: null, licence_number: null,
  website: null, logo_url: null, logo_updated_at: null,
};
const SHIFT_ROW: Row = {
  id: SHIFT, scheduled_start: new Date('2026-10-12T05:00:00Z'), scheduled_end: new Date('2026-10-12T13:00:00Z'),
  site_id: SITE, site_name: 'Harbor Point Plaza', site_tz: 'America/Los_Angeles', company_id: STAR_GUARD,
  client_access_disabled_at: null, guard_name: 'alex rivera', badge_number: 'GRD9001', company_name: 'Star Guard',
  company_active: true,
};
const LOGO = pngImage(512, 512);
const JORDAN = { name: 'jordan lee', email: 'jordan.lee@example.invalid' };
const SAM = { name: 'sam ortiz', email: 'sam.ortiz@example.invalid' };

function world(over: Partial<World> = {}): World {
  return { company: FULL_ROW, clients: [JORDAN], shift: SHIFT_ROW, logo: LOGO, logoDelayMs: 0, sendgrid: () => 'ok', ...over };
}
let W: World = world();
let stamp = 0;
/** A new logo_updated_at per scenario, so the logo cache never carries one over. */
function fresh(row: Row): Row {
  stamp += 1;
  return row.logo_url ? { ...row, logo_updated_at: new RealDate(RealDate.parse('2026-10-12T10:00:00Z') + stamp * 1000).toISOString() } : row;
}

const sqlLog: Array<{ text: string; params: unknown[] }> = [];
const s3Calls: Array<{ key: string; opts: unknown }> = [];
const attempts: Msg[] = [];
const delivered: Msg[] = [];
const sentry: Array<{ kind: 'message' | 'exception'; what: unknown; ctx: any }> = [];
const isLetterheadSql = (q: string) => /FROM companies c/.test(q) && /JOIN sites s ON s\.company_id = c\.id/.test(q);

const T = (s: string) => new RealDate(s);
inject('../src/db/pool', {
  pool: {
    async query(text: string, params: unknown[] = []) {
      const q = String(text);
      sqlLog.push({ text: q, params });
      if (isLetterheadSql(q)) {
        if (W.company === 'throw') throw new Error('stub: database unavailable');
        return { rows: W.company ? [W.company] : [] };
      }
      if (/JOIN client_sites cs ON cs\.site_id = s\.id/.test(q)) {
        return { rows: W.clients.map((c) => ({ site_name: 'Harbor Point Plaza', site_tz: 'America/Los_Angeles', client_name: c.name, client_email: c.email, company_name: 'Star Guard' })) };
      }
      if (/FROM shifts sh\s+JOIN sites/.test(q)) return { rows: [W.shift] };
      if (/FROM client_sites cs\s+JOIN clients c/.test(q)) return { rows: W.clients.map((c, i) => ({ id: `c${i}`, ...c })) };
      if (/FROM shift_sessions ss/.test(q)) {
        return { rows: [{ id: SESSION, clocked_in_at: T('2026-10-12T04:57:00Z'), clocked_out_at: T('2026-10-12T13:02:00Z'), total_hours: '8.08', ping_interval_minutes: 30, scheduled_hours: 8, actual_hours: 8.08, break_hours: 0.5, violation_hours: 0 }] };
      }
      if (/FROM reports WHERE shift_session_id/.test(q)) {
        return { rows: [
          { report_type: 'activity', severity: null, description: 'Patrol completed: all exterior doors locked.', reported_at: T('2026-10-12T06:30:00Z') },
          { report_type: 'incident', severity: null, description: 'Unlocked door at the north loading dock; secured.', reported_at: T('2026-10-12T09:14:00Z') },
        ] };
      }
      if (/FROM task_completions/.test(q)) return { rows: [{ completed: '3' }] };
      if (/FROM task_instances/.test(q)) return { rows: [{ total: '4' }] };
      if (/FROM location_pings/.test(q)) return { rows: [] };
      if (/FROM missed_pings/.test(q)) return { rows: [{ unresolved: '0' }] };
      if (/FROM break_sessions/.test(q)) return { rows: [{ overlaps: false }] };
      if (/^\s*UPDATE shifts SET daily_report_email_sent/.test(q)) return { rows: [], rowCount: 1 };
      throw new Error('unexpected SQL in the B4 harness: ' + q.replace(/\s+/g, ' ').slice(0, 90));
    },
  },
});
class S3ObjectTooLargeError extends Error {}
inject('../src/services/s3', {
  S3ObjectTooLargeError,
  s3KeyFromPublicUrl: (u: string) => (u === LOGO_URL ? 'company-logos/star-guard/logo' : null),
  async getS3ObjectBuffer(key: string, opts: unknown) {
    s3Calls.push({ key, opts });
    if (W.logoDelayMs) await sleep(W.logoDelayMs);
    if (W.logo === 'missing') { const e = new Error('NoSuchKey') as Error & { code: string }; e.code = 'NoSuchKey'; throw e; }
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
const BASEMOD = loadBase('src/services/email.ts');
const LH = require('../src/services/letterhead');
const LHE = require('../src/services/letterhead/email');
const { Mail } = require(require.resolve('@sendgrid/helpers', { paths: [path.dirname(SENDGRID)] })).classes;
/* eslint-enable @typescript-eslint/no-var-requires */

const REPORT = { id: '0b4f0000-0000-4000-8000-0000000000d1', description: 'Unlocked door at the north loading dock; secured.', severity: null, reported_at: T('2026-10-12T09:14:00Z') };

/** Run `fn` against a clean slate: world, logs, logo cache, SendGrid failure state. */
async function run(over: Partial<World>, fn: (mod: any) => Promise<unknown>, mod: any = CUR, at = T0) {
  W = world(over);
  if (W.company && W.company !== 'throw') W.company = fresh(W.company);
  for (const a of [sqlLog, s3Calls, attempts, delivered, sentry] as unknown[][]) a.length = 0;
  LH.logoCache.clear();
  mod.__resetSendgridFailureState?.();
  const t0 = performance.now();
  let result: unknown;
  let error: unknown = null;
  try { result = await frozen(() => fn(mod), at); } catch (e) { error = e; }
  return {
    result, error, ms: performance.now() - t0,
    attempts: [...attempts], delivered: [...delivered], sentry: [...sentry], s3: [...s3Calls],
    lookups: sqlLog.filter((s) => isLetterheadSql(s.text)),
    flagged: sqlLog.filter((s) => /^\s*UPDATE shifts SET daily_report_email_sent/.test(s.text)).length,
  };
}
const incident = (mod: any) => mod.sendIncidentAlert(REPORT, SITE);
const daily = (mod: any) => mod.sendDailyShiftReport(SHIFT);
const payload = (m: Msg) => JSON.stringify(m);
/** Everything but the html, which B5 (N182) inlined: addresses, subject, attachments. */
const envelope = (m: Msg) => JSON.stringify({ ...m, html: undefined });
/** The visible text: a <style> element's CSS is not text; tags out, whitespace collapsed. */
const visibleText = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const sentryNamed = <E extends { what: unknown }>(r: { sentry: E[] }, name: string): E[] => r.sentry.filter((e) => e.what === name);

/** BASE's message with this list of date strings rewritten; each must occur exactly as often as listed. */
type Rewrite = { field: 'subject' | 'html'; from: string; to: string; times: number };
function rewrite(m: Msg, list: Rewrite[]): { msg: Msg; problems: string[] } {
  const out = { ...m };
  const problems: string[] = [];
  for (const r of list) {
    const n = out[r.field].split(r.from).length - 1;
    if (n !== r.times) problems.push(`${r.field} ${JSON.stringify(r.from)} x${n}, expected x${r.times}`);
    out[r.field] = out[r.field].split(r.from).join(r.to);
  }
  return { msg: out, problems };
}
const INCIDENT_DATES: Rewrite[] = [
  { field: 'subject', from: '12 Oct 2026', to: 'Oct 12, 2026', times: 1 },
  { field: 'html', from: 'Harbor Point Plaza · 12 Oct 2026', to: 'Harbor Point Plaza · Oct 12, 2026', times: 1 },
  { field: 'html', from: '12 Oct 2026, 2:14 AM PDT', to: 'Oct 12, 2026, 2:14 AM PDT', times: 1 },
];
const DAILY_DATES: Rewrite[] = [
  { field: 'subject', from: '11 Oct 2026', to: 'Oct 11, 2026', times: 1 },
  { field: 'html', from: 'Harbor Point Plaza · 11 Oct 2026', to: 'Harbor Point Plaza · Oct 11, 2026', times: 1 },
  { field: 'html', from: '11 Oct 2026, 9:57 PM PDT', to: 'Oct 11, 2026, 9:57 PM PDT', times: 1 },
  { field: 'html', from: '12 Oct 2026, 6:02 AM PDT', to: 'Oct 12, 2026, 6:02 AM PDT', times: 1 },
  { field: 'html', from: '11 Oct 2026, 11:30 PM PDT', to: 'Oct 11, 2026, 11:30 PM PDT', times: 1 },
  { field: 'html', from: '12 Oct 2026, 2:14 AM PDT', to: 'Oct 12, 2026, 2:14 AM PDT', times: 1 },
];
const DAY_FIRST = /\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec) \d{4}\b/;

const FULL_LINES = [
  '4100 Mowry Ave, Ste 12, Fremont, CA 94538',
  '(510) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example',
  'License No. PPO 120456',
];
const cidCount = (html: string) => html.split('cid:company-logo').length - 1;

async function main(): Promise<void> {
  section('X — the instrument');
  const baseSrc = execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', `${BASE}:apps/api/src/services/email.ts`], { encoding: 'utf8' });
  check(!baseSrc.includes('letterhead') && fs.readFileSync(path.join(__dirname, '../src/services/email.ts'), 'utf8').includes('mailLetterheadForSite'),
    'X1 BASE is email.ts before B4 (no letterhead); the current one looks it up');
  {
    const r = await run({ company: 'throw' }, incident);
    check(r.attempts.length === 1 && require.cache[SENDGRID]?.exports.default === sgStub, 'X2 email.ts sends through the SendGrid stub');
  }

  section('A — no letterhead: BASE\'s payload, but for the dates');
  for (const [name, fn, dates] of [['incident', incident, INCIDENT_DATES], ['daily', daily, DAILY_DATES]] as const) {
    const base = await run({ company: 'throw' }, fn, BASEMOD);
    const failed = await run({ company: 'throw' }, fn);
    const none = await run({ company: null }, fn);
    const want = rewrite(base.delivered[0], dates as Rewrite[]);
    check(want.problems.length === 0, `A1 ${name}: every listed date rewrite occurs exactly as often as listed in BASE's message${want.problems.length ? ` (${want.problems.join('; ')})` : ''}`);
    check(failed.delivered.length === 1 && envelope(failed.delivered[0]) === envelope(want.msg)
      && visibleText(failed.delivered[0].html) === visibleText(want.msg.html),
      `A2 ${name}: a lookup that fails sends BASE's addresses, subject and visible text (dates rewritten)`);
    check(none.delivered.length === 1 && payload(none.delivered[0]) === payload(failed.delivered[0]),
      `A3 ${name}: a site whose company has no row sends the same payload`);
    check(Object.keys(failed.delivered[0] ?? {}).join() === 'to,from,replyTo,subject,html' && failed.delivered[0]?.replyTo === SUPPORT,
      `A4 ${name}: no attachments key, Reply-To ${SUPPORT}`);
    check(sentryNamed(failed, 'letterhead_lookup_failed').length === 1, `A5 ${name}: the failed lookup is a Sentry warning, once`);
  }

  section('D — dates: month-name, in the site\'s zone, subjects included');
  {
    const inc = await run({}, incident);
    const day = await run({}, daily);
    const incNone = await run({ company: 'throw' }, incident);
    const dayNone = await run({ company: 'throw' }, daily);
    check(inc.delivered[0]?.subject === 'Incident Reported — Harbor Point Plaza — Oct 12, 2026', `D1 incident subject: ${inc.delivered[0]?.subject}`);
    const high = CUR.renderIncidentAlert({ report_id: 'r', description: 'x', severity: 'high', reported_at: REPORT.reported_at, site_name: 'Harbor Point Plaza', site_tz: 'America/Los_Angeles', client_name: 'jordan lee', company_name: 'Star Guard' });
    check(high.subject === 'Incident Reported — Harbor Point Plaza — HIGH — Oct 12, 2026', `D1b incident subject with a severity: ${high.subject}`);
    check(day.delivered[0]?.subject === 'Shift Report — Harbor Point Plaza — Oct 11, 2026', `D2 daily subject: ${day.delivered[0]?.subject}`);
    const incHtml = inc.delivered[0]?.html ?? '';
    const dayHtml = day.delivered[0]?.html ?? '';
    check(incHtml.includes('Harbor Point Plaza · Oct 12, 2026') && incHtml.includes('Oct 12, 2026, 2:14 AM PDT'),
      'D3 incident body: the header line and the timestamp are month-first');
    check(['Harbor Point Plaza · Oct 11, 2026', 'Oct 11, 2026, 9:57 PM PDT', 'Oct 12, 2026, 6:02 AM PDT', 'Oct 11, 2026, 11:30 PM PDT', 'Oct 12, 2026, 2:14 AM PDT'].every((s) => dayHtml.includes(s)),
      'D3b daily body: the header line, clock-in, clock-out and both report times are month-first');
    const left = [inc, day, incNone, dayNone].flatMap((r) => r.delivered).filter((m) => DAY_FIRST.test(m.subject) || DAY_FIRST.test(m.html));
    check(left.length === 0, `D3c no day-first date anywhere, with or without a letterhead${left.length ? ` (${left.map((m) => (m.subject + m.html).match(DAY_FIRST)?.[0]).join(', ')})` : ''}`);
    // An instant after 17:00 PT is still that day in Pacific, and the next one in New York.
    const late = (tz: string) => CUR.renderIncidentAlert({ report_id: 'r', description: 'x', severity: null, reported_at: T('2026-10-13T06:30:00Z'), site_name: 'S', site_tz: tz, client_name: null, company_name: 'C' });
    const zones: string[] = [];
    for (const proc of ['UTC', 'America/Los_Angeles']) {
      process.env.TZ = proc;
      const la = late('America/Los_Angeles');
      const ny = late('America/New_York');
      zones.push(`${la.subject} | ${ny.subject} | ${ny.html.includes('Oct 13, 2026, 2:30 AM EDT')} | ${la.html.includes('Oct 12, 2026, 11:30 PM PDT')}`);
    }
    process.env.TZ = 'UTC';
    check(zones[0] === 'Incident Reported — S — Oct 12, 2026 | Incident Reported — S — Oct 13, 2026 | true | true' && zones[0] === zones[1],
      `D4 dated in the site's zone, the same under a UTC and a Pacific process (${zones[0]})`);
    // D5 (the other nine templates byte-identical to BASE) moved to
    // scripts/test-letterhead-b5.ts: B5 changed every template on purpose
    // (N182 inline styles, month-name dates, letterheads).
  }

  section('L — Star Guard\'s full letterhead and logo');
  for (const [name, fn, title] of [['incident', incident, 'Incident Reported'], ['daily', daily, 'Shift Report']] as const) {
    const r = await run({ clients: [JORDAN, SAM] }, fn);
    const [m1, m2] = r.delivered;
    const html = m1?.html ?? '';
    check(r.delivered.length === 2 && !html.includes('class="hdr"') && !html.includes('>NETRAOPS<')
      && html.includes('>Star Guard</div>') && FULL_LINES.every((l) => html.includes(`>${l}</div>`))
      && html.indexOf(FULL_LINES[0]) < html.indexOf(FULL_LINES[1]) && html.indexOf(FULL_LINES[1]) < html.indexOf(FULL_LINES[2])
      && html.includes(`>${title}</h1>`),
      `L1 ${name}: the company header (name, three contact lines in order, the title) replaces the NetraOps band`);
    check(html.includes('Powered by NetraOps') && html.includes('Provided by <strong style="color:#666">Star Guard</strong>.')
      && html.includes('Reply to this email to contact Star Guard.'),
      `L2 ${name}: the footer ends "Powered by NetraOps", with the reply line (replies reach the company)`);
    const a = m1?.attachments ?? [];
    check(cidCount(html) === 1 && a.length === 1 && a[0].content_id === LHE.LOGO_CONTENT_ID && a[0].disposition === 'inline'
      && a[0].type === 'image/png' && a[0].filename === 'logo.png' && Buffer.from(String(a[0].content), 'base64').equals(LOGO),
      `L3 ${name}: one cid reference and one inline attachment holding the logo's bytes, base64`);
    check(m1?.replyTo === 'dispatch@starguard.example' && m1?.from === 'alerts@example.invalid' && m1?.to === JORDAN.email,
      `L4 ${name}: Reply-To is the company's contact email; From and To unchanged`);
    const json = m1 ? Mail.create(m1).toJSON() : {};
    const ja = json.attachments?.[0] ?? {};
    check(ja.content_id === 'company-logo' && !('contentId' in ja) && ja.disposition === 'inline' && json.reply_to?.email === 'dispatch@starguard.example',
      `L5 ${name}: through the real @sendgrid/helpers the API gets content_id, disposition inline and reply_to`);
    check(r.lookups.length === 1 && r.lookups[0].params[0] === SITE && r.s3.length === 1
      && (m2?.html ?? '').includes('Hi Sam,') && html.includes('Hi Jordan,') && (m2?.attachments ?? []).length === 1,
      `L6 ${name}: two clients, two messages each with the logo; one lookup for the site and one S3 fetch`);
  }
  {
    const r = await run({ logo: jpegImage(400, 160) }, incident);
    const a = r.delivered[0]?.attachments?.[0];
    check(a?.type === 'image/jpeg' && a?.filename === 'logo.jpg' && (r.delivered[0]?.html ?? '').includes('width="150" height="60"'),
      'L7 a JPEG logo (STARNET\'s is one) goes as image/jpeg, logo.jpg, 400x160 drawn at 150x60');
    const box = (w: number, h: number) => {
      const m = LHE.mailLetterhead({ companyName: 'Star Guard', contactEmail: null, phone: null, address: null, licenceNumber: null, website: null, logo: pngImage(w, h) });
      const hh = LHE.mailHeaderHtml(m, 'T', 's');
      return `${m.logo.width}x${m.logo.height}:${hh.includes(`width="${m.logo.width}" height="${m.logo.height}"`) && hh.includes(`width:${m.logo.width}px;height:${m.logo.height}px`)}`;
    };
    const boxes = [box(512, 512), box(1200, 300), box(300, 1200), box(120, 40)].join(' ');
    check(boxes === '60x60:true 180x45:true 15x60:true 120x40:true',
      `L8 the logo fits a 180x60 box, aspect kept, never enlarged, in attributes and style (${boxes})`);
    check(r.s3.length === 1 && (r.s3[0].opts as { timeoutMs?: number }).timeoutMs === LH.LOGO_FETCH_TIMEOUT_MS,
      'L9 the S3 fetch keeps its own 5 s timeout');
  }

  section('N — N167: the letterhead never stops an email');
  {
    const r = await run({ company: EMPTY_ROW }, incident);
    const m = r.delivered[0];
    check(m !== undefined && !m.attachments && cidCount(m.html) === 0 && m.replyTo === SUPPORT && m.html.includes('>Star Guard</div>')
      && !m.html.includes('Reply to this email') && m.html.includes('Powered by NetraOps') && r.s3.length === 0,
      'N1 an empty profile: the name alone, no logo, Reply-To unchanged, no reply line (replies go to NetraOps support)');
    for (const [label, bytes] of [['PNG', pngCorruptAfterHeader(400, 440)], ['JPEG', jpegCorruptAfterHeader(400, 160)]] as const) {
      const c = await run({ logo: bytes }, daily);
      const cm = c.delivered[0];
      check(cm !== undefined && !cm.attachments && cidCount(cm.html) === 0 && FULL_LINES.every((l) => cm.html.includes(l))
        && cm.replyTo === 'dispatch@starguard.example'
        && c.sentry.some((e) => e.what === 'letterhead_logo_unavailable' && e.ctx?.tags?.reason === 'does_not_decode'),
        `N2 a corrupt ${label}: sent with the name and contact lines, no image, a Sentry warning (does_not_decode)`);
    }
    const missing = await run({ logo: 'missing' }, incident);
    check(missing.delivered.length === 1 && !missing.delivered[0].attachments
      && missing.sentry.some((e) => e.what === 'letterhead_logo_unavailable' && e.ctx?.tags?.reason === 'missing'),
      'N3 a logo missing from S3: sent without it, a Sentry warning (missing)');
    // The cap: one byte over is left out, and warned once per logo, not per
    // email: a second alert (its own lookup, the cached logo) warns no more.
    const over = pngPadded(400, 160, LHE.EMAIL_LOGO_MAX_BYTES + 1);
    const heavy = await run({ logo: over }, incident);
    for (const a of [attempts, delivered] as unknown[][]) a.length = 0;
    const warnedBefore = sentry.length;
    await frozen(() => incident(CUR));
    const again = { delivered: [...delivered], sentry: sentry.slice(warnedBefore) };
    const heavyWarn = [...heavy.sentry, ...again.sentry].filter((e) => e.what === 'letterhead_logo_unavailable' && e.ctx?.tags?.reason === 'too_heavy_for_email');
    check(heavy.delivered.length === 1 && again.delivered.length === 1 && [...heavy.delivered, ...again.delivered].every((m) => !m.attachments && cidCount(m.html) === 0)
      && heavyWarn.length === 1 && s3Calls.length === 1,
      `N4 a logo of ${over.length} bytes (cap + 1): two alerts go without it, one Sentry warning for the cached logo`);
    const atCap = pngPadded(400, 160, LHE.EMAIL_LOGO_MAX_BYTES);
    const ok = await run({ logo: atCap }, incident);
    check(ok.delivered[0]?.attachments?.length === 1 && Buffer.from(String(ok.delivered[0].attachments[0].content), 'base64').length === LHE.EMAIL_LOGO_MAX_BYTES,
      `N5 a logo of exactly ${LHE.EMAIL_LOGO_MAX_BYTES} bytes goes`);
    // Slow: S3 answers after 3 s. The email goes at ~2 s without the logo; the
    // fetch finishes into the cache, and the next email carries it at once.
    const slow1 = await run({ logoDelayMs: 3000 }, incident);
    check(slow1.delivered.length === 1 && !slow1.delivered[0].attachments && slow1.ms >= 1900 && slow1.ms < 2700,
      `N6 S3 at 3 s: the alert went without the logo after ${Math.round(slow1.ms)} ms (wait ${LHE.EMAIL_LOGO_WAIT_MS} ms)`);
    await sleep(1300);
    const companyRow = W.company;
    W = world({ logoDelayMs: 3000, company: companyRow });
    for (const a of [sqlLog, s3Calls, attempts, delivered, sentry] as unknown[][]) a.length = 0;
    const t1 = performance.now();
    await frozen(() => incident(CUR));
    const ms2 = performance.now() - t1;
    check(delivered.length === 1 && delivered[0].attachments?.length === 1 && s3Calls.length === 0 && ms2 < 500,
      `N7 the fetch finished into the cache: the next alert carried the logo in ${Math.round(ms2)} ms, no new fetch`);
    // A PDF caller passes no wait and still waits for the fetch.
    LH.logoCache.clear();
    W = world({ logoDelayMs: 3000, company: fresh(FULL_ROW) });
    const t2 = performance.now();
    const pdfLh = await LH.letterheadForSite(SITE);
    const ms3 = performance.now() - t2;
    check(pdfLh?.logo instanceof Buffer && ms3 >= 2900, `N8 a PDF lookup (no wait given) still waited ${Math.round(ms3)} ms for the logo`);
    // A contact email the profile accepts but SendGrid might refuse.
    const odd = await run({ company: { ...FULL_ROW, contact_email: 'ops,desk@starguard.example' } }, incident);
    const om = odd.delivered[0];
    check(om?.replyTo === SUPPORT && !om.html.includes('Reply to this email') && om.html.includes('ops,desk@starguard.example'),
      'N9 "ops,desk@…" (the profile accepts it): Reply-To stays support@, no reply line, the address still prints');
    const plus = await run({ company: { ...FULL_ROW, contact_email: 'ops+alerts@mail.starguard.example' } }, incident);
    check(plus.delivered[0]?.replyTo === 'ops+alerts@mail.starguard.example', 'N10 a plus-address on a subdomain is a usable Reply-To');
    // The helper's own decode check, the backstop for a Letterhead built by hand.
    const byHand = LHE.mailLetterhead({ companyName: 'Star Guard', contactEmail: null, phone: null, address: null, licenceNumber: null, website: null, logo: pngCorruptAfterHeader(400, 440) });
    check(byHand.logo === null && cidCount(LHE.mailHeaderHtml(byHand, 'T', 's')) === 0,
      'N11 a hand-built letterhead with undecodable bytes: no logo, no cid');
  }

  section('E — a poisoned profile is escaped');
  {
    const r = await run({ company: { ...FULL_ROW, name: POISON, address: POISON, phone: POISON, website: POISON, licence_number: POISON } }, daily);
    const html = r.delivered[0]?.html ?? '';
    const esc = `O'Brien &amp; Sons &lt;Site &quot;A&quot;&gt;`;
    check(html.includes(`>${esc}</div>`) && html.includes(`<strong style="color:#666">${esc}</strong>`) && html.includes(`License No. ${esc}`)
      && !html.includes('<Site') && !html.includes('&amp;amp;') && !html.includes('&amp;lt;'),
      'E1 the name, address, phone, website and licence are escaped once, in the header and the footer');
    check(['<table role="presentation"', '<h1 style=', '<div style="background:#f5f5f5;padding:14px 28px', '<div style="padding:24px 28px">'].every((t) => html.includes(t)),
      'E2 the markup survived (no fragment was escaped)');
  }

  section('S — SendGrid refuses a letterhead message');
  {
    const plainIncident = (await run({ company: 'throw' }, incident)).delivered[0];
    const refuse400 = (m: Msg) => (m.attachments ? 400 : 'ok');
    const r = await run({ sendgrid: refuse400 }, incident);
    check(r.attempts.length === 2 && !!r.attempts[0].attachments && r.delivered.length === 1 && payload(r.delivered[0]) === payload(plainIncident),
      'S1 a 400 on the letterhead message: one resend, byte-identical to the email with no letterhead');
    check(sentryNamed(r, 'letterhead_email_refused').length === 1 && sentryNamed(r, 'sendgrid_failing').length === 0,
      'S2 Sentry: letterhead_email_refused once, and no sendgrid_failing (the email went)');
    const d = await run({ sendgrid: refuse400 }, daily);
    check(d.attempts.length === 2 && d.delivered.length === 1 && d.flagged === 1 && (d.result as { status?: string; delivered?: number })?.status === 'sent',
      'S3 the daily report: resent plain, counted delivered, the shift flagged once');
    // Two refusals inside the hour: two resends, one Sentry event. A fresh hour.
    const two = await run({ sendgrid: refuse400, clients: [JORDAN, SAM] }, incident, CUR, '2026-10-12T18:30:00Z');
    check(two.attempts.length === 4 && two.delivered.length === 2 && sentryNamed(two, 'letterhead_email_refused').length === 1,
      'S4 two refusals in the same hour: two plain resends, one Sentry warning');
    const both = await run({ sendgrid: () => 400 }, incident, CUR, '2026-10-12T21:00:00Z');
    const fail = sentryNamed(both, 'sendgrid_failing');
    check(both.attempts.length === 2 && both.delivered.length === 0 && fail.length === 1 && fail[0].ctx?.tags?.status === '400',
      'S5 the resend refused too: two attempts, no third; reported as a SendGrid failure (400)');
    const other = await run({ sendgrid: (m: Msg) => (m.attachments ? 429 : 'ok') }, incident, CUR, '2026-10-12T23:00:00Z');
    check(other.attempts.length === 1 && other.delivered.length === 0 && sentryNamed(other, 'sendgrid_failing')[0]?.ctx?.tags?.status === '429',
      'S6 any other status (429): no resend, reported as before');
    const none = await run({ company: 'throw', sendgrid: () => 400 }, incident, CUR, '2026-10-13T01:00:00Z');
    check(none.attempts.length === 1 && none.delivered.length === 0 && sentryNamed(none, 'letterhead_email_refused').length === 0,
      'S7 no letterhead and a 400: one attempt, no resend');
  }

  section('R — recipients, skips and flagging unchanged');
  {
    const noClient = await run({ clients: [] }, daily);
    check((noClient.result as { status?: string; reason?: string })?.reason === 'no_client' && noClient.lookups.length === 0 && noClient.attempts.length === 0,
      'R1 a shift with no active client is skipped before any letterhead lookup');
    const inactive = await run({ shift: { ...SHIFT_ROW, company_active: false } }, daily);
    check((inactive.result as { reason?: string })?.reason === 'company_inactive' && inactive.lookups.length === 0,
      'R2 an inactive company\'s shift is skipped before any lookup');
    const noAlert = await run({ clients: [] }, incident);
    check(noAlert.lookups.length === 0 && noAlert.attempts.length === 0 && noAlert.sentry.some((e) => e.what === 'sendIncidentAlert: no active clients for site'),
      'R3 an alert with no active client: no lookup, no send, the warning as before');
    const sent = await run({ clients: [JORDAN, SAM] }, daily);
    check(sent.flagged === 1 && (sent.result as { delivered?: number })?.delivered === 2 && sent.lookups.length === 1 && sent.lookups[0].params[0] === SITE,
      'R4 a sent shift: one lookup for its site, two delivered, flagged once');
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
