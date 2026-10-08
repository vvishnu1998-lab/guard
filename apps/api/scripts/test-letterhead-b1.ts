/**
 * test-letterhead-b1.ts — the company letterhead on the admin surfaces (Phase B, stage B1).
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-letterhead-b1.ts     (from apps/api)
 *
 * Needs poppler (pdftotext, pdfimages) and git: the "before" side of every
 * identity check is the file as it was at BASE (main before B1), read from
 * git and compiled beside the current one, so its relative imports resolve to
 * the same dependencies. LOCAL DATABASES ONLY; fake data on Star Guard's id
 * and on a second, invented company. Sentry, email and S3 are stubbed.
 *
 * ── WITH NO LETTERHEAD, NOTHING CHANGES ────────────────────────────────────
 * A letterhead lookup that fails returns null (services/letterhead never
 * throws), and every surface then has to produce exactly what it produced at
 * BASE. Each identity check below compares bytes under a frozen clock, and
 * each has a control that shows the comparison can fail.
 *
 *   T  contactLines() moved from letterhead/pdf.ts to letterhead/text.ts
 */
import Module from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { pngImage } from './image-fixtures';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** main before B1: PR #95's merge. Every "before" is read from here. */
const BASE = '09791ddc9326ffd1bb0639c6835819dafeaebd67';
const T0 = '2026-10-07T19:00:00Z';

process.env.S3_BUCKET = 'test-bucket';
process.env.AWS_REGION = 'us-east-1';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  const url = process.env.DATABASE_URL;
  if (url) {
    let h = '';
    try { h = new URL(url).hostname; } catch { h = '(unparseable)'; }
    if (!LOCAL_HOSTS.has(h)) { console.error(`REFUSING: DATABASE_URL points at ${h}.`); process.exit(2); }
  }
}
function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}

let failures = 0;
let passes = 0;

// A harness that stops before its last check must not pass: an await that never
// settles drains the event loop, and Node would then exit 0 having printed nothing.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)');
    process.exitCode = 1;
  }
});
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

// ── the clock ──────────────────────────────────────────────────────────────
const RealDate = Date;
async function frozen<T>(fn: () => Promise<T>): Promise<T> {
  const t = RealDate.parse(T0);
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

// ── the "before" side ──────────────────────────────────────────────────────
/**
 * `apps/api/<rel>` as it was at BASE (or that source run through `edit`),
 * compiled as a fresh module under the CURRENT file's path. It is not put in
 * require.cache: nothing else sees it, and its own requires resolve exactly as
 * the current file's do.
 */
function loadBase(rel: string, edit?: (src: string) => string): any {
  const file = path.join(__dirname, '..', rel);
  const src = execFileSync('git', ['show', `${BASE}:apps/api/${rel}`], { encoding: 'utf8' });
  const edited = edit ? edit(src) : src;
  if (edit && edited === src) throw new Error(`loadBase(${rel}): the edit changed nothing`);
  const js = ts.transpileModule(edited, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}

// ── letterheads ────────────────────────────────────────────────────────────
const LOGO = pngImage(400, 160);
const FULL = {
  companyName: 'Star Guard', contactEmail: 'dispatch@starguard.example', phone: '(408) 555-0142',
  address: '1200 Example Avenue, Suite 300\nSan Jose, CA 95110', licenceNumber: 'PPO 120456',
  website: 'https://www.starguard.example/', logo: LOGO,
};
const EMPTY = { companyName: 'Star Guard', contactEmail: null, phone: null, address: null, licenceNumber: null, website: null, logo: null };
const LONG = {
  companyName: 'Star Guard Protective Services & Event Security of Northern California, LLC',
  contactEmail: 'after-hours-dispatch-and-scheduling@starguard-protective-services.example', phone: '+1 (408) 555-0142 ext. 2201',
  address: '1200 Example Avenue, Building C, Suite 300, Attn: Operations Desk\nSan Jose, CA 95110-1234',
  licenceNumber: 'PPO 120456 / ALARM ACO 7781 / PI 29981', website: 'https://www.starguard-protective-services.example/locations', logo: LOGO,
};

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  const PDFDocument = (await import('pdfkit')).default;

  /** A one-page document drawn with a letterhead module's header and footer. */
  async function letterheadPage(mod: any, lh: unknown): Promise<Buffer> {
    const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    mod.drawLetterheadHeader(doc, 'ACTIVITY LOGS', 1, 1, lh);
    mod.drawLetterheadFooter(doc, 'All sites  |  01/10/2026 – 07/10/2026', lh);
    doc.end();
    await done;
    return Buffer.concat(chunks);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section(`T  contactLines() moved to letterhead/text.ts: the letterhead PDF is the same bytes as at ${BASE.slice(0, 7)}`);
  {
    const { contactLines } = await import('../src/services/letterhead/text');
    check(JSON.stringify(contactLines(FULL as never)) === JSON.stringify([
      '1200 Example Avenue, Suite 300, San Jose, CA 95110',
      '(408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example',
      'License No. PPO 120456',
    ]), 'T1 contactLines: address on one line; phone · email · website (protocol and trailing slash dropped); License No.');
    check(contactLines(EMPTY as never).length === 0
      && JSON.stringify(contactLines({ ...EMPTY, contactEmail: 'a@b.example' } as never)) === '["a@b.example"]',
      'T2 contactLines skips every empty line: an empty profile has none; one field gives one line');
    const base = loadBase('src/services/letterhead/pdf.ts');
    const current = require('../src/services/letterhead/pdf');
    check(!String(base.drawLetterheadHeader).includes('text_1') && String(current.drawLetterheadHeader).includes('text_1.contactLines'),
      'T3 the base is the pre-move pdf.ts (contactLines inline), the current one calls it from text.ts');
    for (const [label, lh] of [['full profile with logo', FULL], ['empty profile', EMPTY], ['every field at an extreme length', LONG]] as const) {
      const before = await frozen(() => letterheadPage(base, lh));
      const after = await frozen(() => letterheadPage(current, lh));
      check(before.equals(after), `T4 ${label}: ${sha(before)} = ${sha(after)} (${after.length} bytes)`);
    }
    const mutant = loadBase('src/services/letterhead/pdf.ts', (s) => s.replace('`License No. ${lh.licenceNumber}`', '`License No: ${lh.licenceNumber}`'));
    const m = await frozen(() => letterheadPage(mutant, FULL));
    check(!m.equals(await frozen(() => letterheadPage(current, FULL))), 'T5 control: the base with one character of the licence line changed DIFFERS');
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
