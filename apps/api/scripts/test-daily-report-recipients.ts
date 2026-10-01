/**
 * Proof for D24 (OPEN-ITEMS N161): who receives the daily shift report, and
 * when a shift is flagged daily_report_email_sent.
 *
 * THE RULE UNDER TEST. Every active client linked to the site through
 * client_sites, in the site's own company, gets one message (personalized
 * greeting). Sites with client access disabled, or whose company is inactive,
 * get none. A skip is logged and counted, never flagged. A shift is flagged
 * once at least one recipient got it; if every recipient failed it stays
 * unflagged. Plus the incident alert: a render that throws must not escape
 * Promise.allSettled.
 *
 * MODES. fix = the branch's email.ts and jobs/dailyShiftEmail.ts as they are.
 * main = origin/main's two files compiled in their place: the negative
 * control, valid only while nothing else under apps/api/src differs from
 * origin/main, which this asserts (untracked files included). M1..M13 = the
 * branch files with one textual mutation each, every edit asserted to match
 * exactly once. Each mode must fail EXACTLY its predicted set (predicted()
 * below, written before the first run). Fix-only checks (F.*) assert the new
 * API and log format; they are not evaluated in main mode.
 *
 * LOCAL CLUSTER ONLY. Refuses unless DATABASE_URL is unset, DOTENV_CONFIG_PATH
 * is /dev/null (services/sentry.ts imports dotenv/config), PGHOST is local,
 * PGPORT is set and not 5432, N161_PGDATA is under /private/tmp and holds the
 * NETRAOPS_THROWAWAY marker, SHOW data_directory on PGPORT is that directory,
 * the database holds no company yet, and SENDGRID_FROM_EMAIL is
 * @example.invalid. @sendgrid/mail, services/sentry and jobs/_run are replaced
 * in require.cache BEFORE email.ts loads, and the stub is asserted to be the
 * module email.ts resolved. Every address is @example.invalid. Nothing can
 * reach SendGrid, Sentry or a real database.
 *
 * COVERAGE. 16 seeded cases (C0–C14, C16) and one cross-cutting check (C15).
 * Not reachable with these fixtures, so not proven: a render that fails for
 * some recipients and not others, and the 'mixed' stage. The render input
 * differs between recipients only by the client's name.
 *
 * RUN (from apps/api; one fresh database per mode, from a migrated template):
 *   env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null PGHOST=127.0.0.1 PGPORT=<port> \
 *     PGUSER=tester PGDATABASE=<fresh db> N161_PGDATA=<data dir> \
 *     SENDGRID_API_KEY=SG.stub SENDGRID_FROM_EMAIL=reports@example.invalid \
 *     node -r ts-node/register/transpile-only scripts/test-daily-report-recipients.ts \
 *     --mode fix [--payload-out <file>]
 * --payload-out writes C0's full send payload (fixed timestamps). It must be
 * byte-identical between --mode main and --mode fix: a single-client site gets
 * exactly the email it got before.
 */
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const API = path.resolve(__dirname, '..');
const REPO = path.resolve(API, '../..');
const EMAIL_TS = path.join(API, 'src/services/email.ts');
const JOB_TS = path.join(API, 'src/jobs/dailyShiftEmail.ts');

const out = console.log.bind(console);
function refuse(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const MODE = arg('--mode') ?? refuse('--mode is required (fix, main, M1..M13).');
const PAYLOAD_OUT = arg('--payload-out');

// ── Refusals: before any app module loads ────────────────────────────────────
if (process.env.DATABASE_URL !== undefined) refuse('DATABASE_URL must be unset.');
if (process.env.DOTENV_CONFIG_PATH !== '/dev/null') refuse('DOTENV_CONFIG_PATH must be /dev/null.');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST ?? '')) refuse('PGHOST must be local.');
const PORT = Number(process.env.PGPORT);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT === 5432) refuse('PGPORT must be set and must not be 5432.');
const PGDATA = fs.realpathSync(process.env.N161_PGDATA ?? refuse('N161_PGDATA is required.'));
if (!PGDATA.startsWith('/private/tmp/')) refuse('N161_PGDATA must be under /private/tmp.');
if (!fs.existsSync(path.join(PGDATA, 'NETRAOPS_THROWAWAY'))) refuse('N161_PGDATA has no NETRAOPS_THROWAWAY marker.');
if (!(process.env.SENDGRID_FROM_EMAIL ?? '').endsWith('@example.invalid')) refuse('SENDGRID_FROM_EMAIL must be @example.invalid.');
process.env.NODE_ENV = 'test';
delete process.env.SENTRY_DSN;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
}
const changedSrc = [
  ...git('diff', '--name-only', 'origin/main', '--', 'apps/api/src').split('\n'),
  ...git('ls-files', '--others', '--exclude-standard', '--', 'apps/api/src').split('\n'),
].filter(Boolean);
// *.test.ts files are allowed too: nothing under test imports them.
const allowed = new Set(['apps/api/src/jobs/dailyShiftEmail.ts', 'apps/api/src/services/email.ts']);
if (MODE === 'main' && !changedSrc.every((f) => allowed.has(f) || f.endsWith('.test.ts'))) {
  refuse(`main mode is a valid control only if apps/api/src differs from origin/main in email.ts and dailyShiftEmail.ts alone (plus *.test.ts); got: ${changedSrc.join(', ')}`);
}

// ── Stubs: injected before email.ts resolves them ────────────────────────────
type Msg = { to: unknown; from: unknown; replyTo: unknown; subject: string; html: string };
type Sent = Msg & { run: number };
const attempts: Sent[] = [];
const delivered: Sent[] = [];
const REJECT = new Set<string>();
const sentry: Array<{ kind: 'exception' | 'message'; value: any; ctx: any; run: number }> = [];
const logs: Array<{ line: string; run: number }> = [];
let RUN = 0;

function inject(filename: string, exports: unknown): void {
  const m = new Module(filename);
  m.filename = filename;
  m.loaded = true;
  m.exports = exports;
  require.cache[filename] = m as unknown as NodeModule;
}
const SENDGRID = require.resolve('@sendgrid/mail', { paths: [path.dirname(EMAIL_TS)] });
const sgStub = {
  setApiKey(): void {},
  async send(msg: Msg): Promise<unknown> {
    attempts.push({ ...msg, run: RUN });
    const to = Array.isArray(msg.to) ? msg.to : [msg.to];
    const bad = to.find((t) => REJECT.has(String(t)));
    if (bad !== undefined) {
      const e: any = new Error('stub rejection');
      e.code = 550;
      throw e;
    }
    delivered.push({ ...msg, run: RUN });
    return [{ statusCode: 202 }, {}];
  },
};
inject(SENDGRID, { __esModule: true, default: sgStub });
inject(require.resolve(path.join(API, 'src/services/sentry')), {
  Sentry: {
    captureException(value: unknown, ctx?: unknown): string { sentry.push({ kind: 'exception', value, ctx, run: RUN }); return 'stub'; },
    captureMessage(value: unknown, ctx?: unknown): string { sentry.push({ kind: 'message', value, ctx, run: RUN }); return 'stub'; },
  },
  tagRequest(): void {},
});
let jobFn = null as (() => Promise<void>) | null;
inject(require.resolve(path.join(API, 'src/jobs/_run')), {
  runJob(name: string, _schedule: string, fn: () => Promise<void>): void {
    if (name === 'dailyShiftEmail') jobFn = fn;
  },
});

const fmt = (a: unknown): string => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a));
console.log = (...a: unknown[]): void => { logs.push({ line: a.map(fmt).join(' '), run: RUN }); };
console.error = (...a: unknown[]): void => { logs.push({ line: a.map(fmt).join(' '), run: RUN }); };
console.warn = console.error;

// ── Load the code under test for this mode ───────────────────────────────────
function tsOptions(): ts.CompilerOptions {
  const cfg = ts.readConfigFile(path.join(API, 'tsconfig.json'), ts.sys.readFile);
  return { ...ts.parseJsonConfigFileContent(cfg.config, ts.sys, API).options, module: ts.ModuleKind.CommonJS };
}
function compileInto(filename: string, source: string): void {
  const js = ts.transpileModule(source, { compilerOptions: tsOptions(), fileName: filename }).outputText;
  const m = new Module(filename, module as unknown as Module);
  m.filename = filename;
  m.paths = (Module as any)._nodeModulePaths(path.dirname(filename));
  require.cache[filename] = m as unknown as NodeModule;
  (m as any)._compile(js, filename);
  m.loaded = true;
}
function mutate(source: string, edits: Array<[string, string]>, label: string): string {
  let s = source;
  for (const [from, to] of edits) {
    const n = s.split(from).length - 1;
    if (n !== 1) refuse(`${label}: anchor matched ${n} times, expected exactly 1: ${JSON.stringify(from.slice(0, 80))}`);
    s = s.replace(from, to);
  }
  return s;
}

const DAILY_RECIPIENTS = '       FROM client_sites cs\n       JOIN clients c ON c.id = cs.client_id\n      WHERE cs.site_id = $1\n        AND c.is_active = true\n';
const MUTATIONS: Record<string, { what: string; edits: Array<[string, string]> }> = {
  M1: { what: 'recipients by legacy clients.site_id instead of client_sites',
    edits: [[DAILY_RECIPIENTS, '       FROM clients c\n      WHERE c.site_id = $1\n        AND c.is_active = true\n']] },
  M2: { what: 'is_active filter dropped from the recipients',
    edits: [[DAILY_RECIPIENTS, '       FROM client_sites cs\n       JOIN clients c ON c.id = cs.client_id\n      WHERE cs.site_id = $1\n']] },
  M3: { what: 'no-client skips flagged sent again (the old behaviour)',
    edits: [["  if (recipients.length === 0) return skip('no_client', 'no active client');",
      "  if (recipients.length === 0) { await pool.query('UPDATE shifts SET daily_report_email_sent = true, daily_report_email_sent_at = NOW() WHERE id = $1', [shiftId]); return skip('no_client', 'no active client'); }"]] },
  M4: { what: 'company guard dropped from the recipients',
    edits: [['        AND c.company_id = $2\n      ORDER BY c.email`,', '        AND $2::uuid IS NOT NULL\n      ORDER BY c.email`,']] },
  M5: { what: 'daily_report_email_sent = false dropped from the shift query',
    edits: [['     JOIN companies      co ON co.id = si.company_id\n     WHERE sh.id = $1 AND sh.daily_report_email_sent = false`,\n    [shiftId],\n  );\n  if (!shiftResult.rows[0]) return { status',
      '     JOIN companies      co ON co.id = si.company_id\n     WHERE sh.id = $1`,\n    [shiftId],\n  );\n  if (!shiftResult.rows[0]) return { status']] },
  M6: { what: 'flagged only when EVERY recipient got it', edits: [['  if (delivered === 0) {', '  if (delivered < recipients.length) {']] },
  M7: { what: 'one multi-recipient send instead of one message per recipient',
    edits: [['    recipients.map(async (r) => {', '    [recipients[0]].map(async (r) => {'], ['        to:      r.email,', '        to:      recipients.map((x) => x.email) as any,']] },
  M8: { what: 'daily report rendered outside the async callback',
    edits: [['    recipients.map(async (r) => {\n      let rendered: { subject: string; html: string };\n      try {\n        rendered = renderDailyShiftReport({ ...report, client_name: r.name });\n      } catch (err) {\n        throw new EmailRenderError(err);\n      }\n',
      '    recipients.map((r) => ({ r, rendered: renderDailyShiftReport({ ...report, client_name: r.name }) })).map(async ({ r, rendered }) => {\n']] },
  M9: { what: 'client-access gate dropped', edits: [["  if (sh.client_access_disabled_at) return skip('client_access_disabled', 'client access disabled');\n", '']] },
  M10: { what: 'inactive-company gate dropped', edits: [["  if (!sh.company_active) return skip('company_inactive', 'company inactive');\n", '']] },
  M12: { what: 'daily-report render failure also sent to the SendGrid failure reporter',
    edits: [['      renderFailed++;\n', "      renderFailed++;\n      reportSendgridFailure('daily_shift_report', o.reason, { shift_id: shiftId });\n"]] },
  M13: { what: 'incident-alert render failure also sent to the SendGrid failure reporter',
    edits: [['      console.error(`[email] sendIncidentAlert: RENDER FAILED for ${email} (report=${report.id})`);\n',
      "      console.error(`[email] sendIncidentAlert: RENDER FAILED for ${email} (report=${report.id})`);\n      reportSendgridFailure('incident_alert', o.reason, { report_id: report.id });\n"]] },
  M11: { what: 'incident alert rendered synchronously in the .map again',
    edits: [['    result.rows.map(async (row) => {\n      let rendered: { subject: string; html: string };\n      try {\n        rendered = renderIncidentAlert({',
      '    result.rows.map((row) => {\n      let rendered: { subject: string; html: string };\n      {\n        rendered = renderIncidentAlert({'],
      ['      } catch (err) {\n        throw new EmailRenderError(err);\n      }\n      return sgMail.send({ to: row.client_email', '      }\n      return sgMail.send({ to: row.client_email']] },
};

if (MODE === 'main') {
  compileInto(EMAIL_TS, git('show', 'origin/main:apps/api/src/services/email.ts'));
  compileInto(JOB_TS, git('show', 'origin/main:apps/api/src/jobs/dailyShiftEmail.ts'));
} else if (MODE !== 'fix') {
  const m = MUTATIONS[MODE] ?? refuse(`unknown mode ${MODE}`);
  compileInto(EMAIL_TS, mutate(fs.readFileSync(EMAIL_TS, 'utf8'), m.edits, MODE));
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const email: any = require(EMAIL_TS);
// eslint-disable-next-line @typescript-eslint/no-var-requires
require(JOB_TS);
const emailModule = require.cache[EMAIL_TS];
if (!emailModule || !emailModule.children.some((c) => c.filename === SENDGRID && c.exports.default === sgStub)) {
  refuse('email.ts did not resolve the @sendgrid/mail stub.');
}
if (!jobFn) refuse('dailyShiftEmail did not register through the runJob stub.');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pool } = require(path.join(API, 'src/db/pool'));

// ── Checks ───────────────────────────────────────────────────────────────────
const results: Array<{ id: string; pass: boolean | null; detail: string }> = [];
function check(id: string, pass: boolean, detail: string): void {
  if (id.startsWith('F.') && MODE === 'main') {
    results.push({ id, pass: null, detail: 'n/a in main mode (fix-only API/log check)' });
    return;
  }
  results.push({ id, pass, detail });
}

function predicted(mode: string): string[] {
  // Written before the first run. main: today's code emails by clients.site_id
  // (rows[0]), flags every no-client skip, ignores the access/company gates,
  // logs SendGrid errors without the recipient, tags every job failure
  // service:sendgrid, and renders the incident alert synchronously. Each
  // mutation removes one piece of the fix. Revised once, after the Phase 1
  // verifier, before re-running: C12.3 (main), C11.3 (M7), M12, M13.
  switch (mode) {
    case 'fix': return [];
    case 'main': return ['C2.1', 'C3.1', 'C3.2', 'C4.2', 'C6.1b', 'C6.2', 'C7.1', 'C7.2', 'C8.2', 'C9.1', 'C9.2',
      'C10.1', 'C10.2', 'C11.1', 'C11.3', 'C12.3', 'C14.2', 'C16.1', 'C16.3', 'INV.1', 'RUN2.2'];
    case 'M1': return ['C2.1', 'C2.2', 'C3.1', 'C3.2', 'C6.2', 'C7.1', 'C7.2', 'C11.1', 'C11.3', 'F.2', 'F.3', 'RUN2.2'];
    case 'M2': return ['C4.1', 'C4.2', 'C5.1', 'F.2', 'F.3', 'F.5'];
    case 'M3': return ['C4.2', 'C6.1b', 'C6.2', 'C7.2', 'C8.2', 'F.3', 'INV.1', 'RUN2.2'];
    case 'M4': return ['C8.1', 'C8.2', 'F.2', 'F.3', 'F.5'];
    case 'M5': return ['C13.1', 'F.1'];
    case 'M6': return ['C11.2', 'F.2', 'F.3', 'INV.1', 'RUN2.1', 'RUN2.2'];
    case 'M7': return ['C11.1', 'C11.2', 'C11.3', 'C15', 'C3.2', 'F.2', 'F.3'];
    case 'M8': return ['F.2', 'F.3', 'F.4'];
    case 'M9': return ['C9.1', 'C9.2', 'F.2', 'F.3', 'F.5'];
    case 'M10': return ['C10.1', 'C10.2', 'F.2', 'F.3', 'F.5'];
    case 'M11': return ['C16.1', 'C16.3'];
    case 'M12': return ['C14.3'];
    case 'M13': return ['C16.4'];
    default: return refuse(`no prediction for ${mode}`);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const q = (sql: string, params: unknown[] = []): Promise<any> => pool.query(sql, params);
const HASH = '$2b$12$n161n161n161n161n161n.u0000000000000000000000000000000';
let seq = 0;
async function company(name: string, active = true): Promise<string> {
  return (await q('INSERT INTO companies (name, is_active) VALUES ($1, $2) RETURNING id', [name, active])).rows[0].id;
}
async function site(co: string, name: string, opts: { tz?: string; disabled?: boolean } = {}): Promise<string> {
  return (await q(
    `INSERT INTO sites (company_id, name, address, contract_start, timezone, client_access_disabled_at)
     VALUES ($1, $2, 'n161 test address', '2026-01-01', $3, CASE WHEN $4::boolean THEN NOW() ELSE NULL END) RETURNING id`,
    [co, name, opts.tz ?? 'America/Los_Angeles', opts.disabled ?? false],
  )).rows[0].id;
}
async function client(co: string, primary: string, name: string, addr: string, links: string[], active = true): Promise<string> {
  const id = (await q(
    `INSERT INTO clients (site_id, company_id, name, email, password_hash, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [primary, co, name, addr, HASH, active],
  )).rows[0].id;
  for (const s of links) await q('INSERT INTO client_sites (client_id, site_id) VALUES ($1, $2)', [id, s]);
  return id;
}
async function shift(co: string, s: string, opts: { fixed?: boolean; session?: boolean; flagged?: boolean } = {}): Promise<string> {
  seq += 1;
  const g = (await q(
    `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [co, `Guard ${seq}`, `guard${seq}@example.invalid`, HASH, `N161-${seq}`],
  )).rows[0].id;
  const [start, end] = opts.fixed
    ? ["'2026-06-15 15:00:00+00'::timestamptz", "'2026-06-15 23:00:00+00'::timestamptz"]
    : ["NOW() - INTERVAL '11 hours'", "NOW() - INTERVAL '3 hours'"];
  const id = (await q(
    `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status, daily_report_email_sent)
     VALUES ($1, $2, ${start}, ${end}, 'completed', $3) RETURNING id`,
    [s, g, opts.flagged ?? false],
  )).rows[0].id;
  if (opts.session !== false) {
    await q(
      `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords, total_hours, ping_interval_minutes)
       VALUES ($1, $2, $3, ${start} + INTERVAL '2 minutes', ${end} - INTERVAL '2 minutes', '37.0,-122.0', 7.93, 30)`,
      [id, g, s],
    );
  }
  return id;
}

type Case = { site: string; siteName: string; shift?: string };
const C: Record<string, Case> = {};
const A: Record<string, string> = {}; // label -> address

async function seed(): Promise<void> {
  const ta = await company('N161 Tenant A');
  const tb = await company('N161 Tenant B');
  const tc = await company('N161 Tenant C (inactive)', false);
  const mk = async (key: string, co: string, opts: { tz?: string; disabled?: boolean } = {}): Promise<string> => {
    const siteName = `N161-${key} site`;
    const id = await site(co, siteName, opts);
    C[key] = { site: id, siteName };
    return id;
  };
  const other = async (key: string, co: string): Promise<string> => site(co, `N161-${key} other site`);
  const addr = (label: string): string => { A[label] = `${label.toLowerCase()}@example.invalid`; return A[label]; };

  const s0 = await mk('C0', ta); await client(ta, s0, 'Olive Zero', addr('K0'), [s0]);
  C.C0.shift = await shift(ta, s0, { fixed: true });

  const s1 = await mk('C1', ta); await client(ta, s1, 'Ada One', addr('K1'), [s1]);
  const s2 = await mk('C2', ta); const s2b = await other('C2', ta); await client(ta, s2b, 'Bea Two', addr('K2'), [s2b, s2]);
  const s3 = await mk('C3', ta); const s3b = await other('C3', ta);
  await client(ta, s3, 'Alda Three', addr('K3a'), [s3]); await client(ta, s3b, 'Brio Three', addr('K3b'), [s3b, s3]);
  const s4 = await mk('C4', ta); await client(ta, s4, 'Cleo Four', addr('K4'), [s4], false);
  const s5 = await mk('C5', ta); const s5b = await other('C5', ta);
  await client(ta, s5, 'Dina Five', addr('K5a'), [s5]); await client(ta, s5b, 'Edda Five', addr('K5b'), [s5b, s5], false);
  const s6 = await mk('C6', ta); const s6b = await other('C6', ta); await client(ta, s6b, 'Fern Six', addr('K6'), [s6b]);
  const s7 = await mk('C7', ta); const s7b = await other('C7', ta); await client(ta, s7, 'Gwen Seven', addr('K7'), [s7b]);
  const s8 = await mk('C8', ta); const sb = await other('C8B', tb); await client(tb, sb, 'Hugo Eight', addr('KB'), [sb, s8]);
  const s9 = await mk('C9', ta, { disabled: true }); await client(ta, s9, 'Iris Nine', addr('K9'), [s9]);
  const s10 = await mk('C10', tc); await client(tc, s10, 'Juno Ten', addr('K10'), [s10]);
  const s11 = await mk('C11', ta); const s11b = await other('C11', ta);
  await client(ta, s11, 'Kira Eleven', addr('K11a'), [s11]); await client(ta, s11b, 'Lena Eleven', addr('K11b'), [s11b, s11]);
  REJECT.add(A.K11b);
  const s12 = await mk('C12', ta); await client(ta, s12, 'Mona Twelve', addr('K12'), [s12]); REJECT.add(A.K12);
  const s13 = await mk('C13', ta); await client(ta, s13, 'Nora Thirteen', addr('K13'), [s13]);
  const s14 = await mk('C14', ta, { tz: 'Invalid/Zone' }); await client(ta, s14, 'Opal Fourteen', addr('K14'), [s14]);
  const s16 = await mk('C16', ta); const s16b = await other('C16', ta);
  await client(ta, s16, 'Pia Sixteen', addr('K16a'), [s16]); await client(ta, s16b, 'Quin Sixteen', addr('K16b'), [s16b, s16]);

  for (const k of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C11', 'C12']) C[k].shift = await shift(ta, C[k].site);
  C.C10.shift = await shift(tc, C.C10.site);
  C.C13.shift = await shift(ta, C.C13.site, { flagged: true });
  C.C14.shift = await shift(ta, C.C14.site, { session: false });
}

// ── Helpers over the captured traffic ────────────────────────────────────────
const toList = (m: Msg): string[] => (Array.isArray(m.to) ? m.to.map(String) : [String(m.to)]);
const forCase = (m: Msg, key: string): boolean => (m.subject + m.html).includes(C[key].siteName);
const reached = (key: string, label: string, run?: number): number =>
  delivered.filter((m) => (run === undefined || m.run === run) && forCase(m, key) && toList(m).includes(A[label])).length;
const attempted = (key: string, label: string): number =>
  attempts.filter((m) => forCase(m, key) && toList(m).includes(A[label])).length;
const deliveredFor = (key: string): number => delivered.filter((m) => forCase(m, key)).length;
async function flagged(key: string): Promise<boolean> {
  return (await q('SELECT daily_report_email_sent FROM shifts WHERE id = $1', [C[key].shift])).rows[0].daily_report_email_sent;
}
const logLines = (run: number): string[] => logs.filter((l) => l.run === run).map((l) => l.line);
function doneLine(run: number): { sent: number; partial: number; skipped: number; reasons: Record<string, number>; failed: number; ok: number; bad: number } | null {
  const line = logLines(run).find((l) => l.startsWith('[daily-email] Done'));
  const m = line?.match(/Done — sent: (\d+) \(partial: (\d+)\), skipped: (\d+)(?: \(([^)]*)\))?, failed: (\d+); emails delivered: (\d+), failed: (\d+)$/);
  if (!m) return null;
  const reasons: Record<string, number> = {};
  for (const part of (m[4] ?? '').split(', ').filter(Boolean)) {
    const [k, v] = part.split(' ');
    reasons[k] = Number(v);
  }
  return { sent: +m[1], partial: +m[2], skipped: +m[3], reasons, failed: +m[5], ok: +m[6], bad: +m[7] };
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sentryFor = (shiftKey: string, run: number) =>
  sentry.filter((e) => e.kind === 'exception' && e.run === run && e.ctx?.extra?.shift_id === C[shiftKey].shift);

async function main(): Promise<void> {
  const dataDir = (await q('SHOW data_directory')).rows[0].data_directory;
  if (fs.realpathSync(dataDir) !== PGDATA) refuse(`the server on PGPORT runs ${dataDir}, not N161_PGDATA.`);
  if (Number((await q('SELECT count(*) AS n FROM companies')).rows[0].n) !== 0) refuse('the database is not empty.');
  await seed();

  // Direct calls (RUN 0).
  const o0 = await email.sendDailyShiftReport(C.C0.shift);
  const c0 = delivered.filter((m) => forCase(m, 'C0'));
  check('C0.1', c0.length === 1 && reached('C0', 'K0') === 1, `single client: ${c0.length} message(s), reaching K0 ${reached('C0', 'K0')}`);
  if (PAYLOAD_OUT && c0[0]) {
    const { to, from, replyTo, subject, html } = c0[0];
    fs.writeFileSync(PAYLOAD_OUT, JSON.stringify({ to, from, replyTo, subject, html }));
  }
  const o13 = await email.sendDailyShiftReport(C.C13.shift);
  check('C13.1', deliveredFor('C13') === 0 && attempts.filter((m) => forCase(m, 'C13')).length === 0, `already-flagged shift: ${attempts.filter((m) => forCase(m, 'C13')).length} attempt(s)`);
  check('F.1', same(o0, { status: 'sent', delivered: 1, failed: 0 }) && same(o13, { status: 'skipped', reason: 'not_pending' }),
    `outcomes C0 ${JSON.stringify(o0)}, C13 ${JSON.stringify(o13)}`);

  // Render failures must never reach the SendGrid failure reporter. Reset its
  // per-flow state first: in the job run, C11 and C12 have already put the flow
  // into "failing", which would hide a transition.
  email.__resetSendgridFailureState();
  const mark14 = { s: sentry.length, l: logs.length };
  try { await email.sendDailyShiftReport(C.C14.shift); } catch { /* expected: every recipient's render fails */ }
  const sgFail = (fromS: number, fromL: number, flow: string): number =>
    sentry.slice(fromS).filter((e) => e.kind === 'message' && e.value === 'sendgrid_failing' && e.ctx?.tags?.flow === flow).length
    + logs.slice(fromL).filter((l) => l.line.startsWith(`[sendgrid.fail] flow=${flow}`)).length;
  check('C14.3', sgFail(mark14.s, mark14.l, 'daily_shift_report') === 0, `direct C14 call: SendGrid-failure reports ${sgFail(mark14.s, mark14.l, 'daily_shift_report')}`);

  email.__resetSendgridFailureState();
  const mark16 = { s: sentry.length, l: logs.length };
  let incidentThrew = '';
  try {
    await email.sendIncidentAlert({ id: '00000000-0000-4000-8000-000000000016', description: 'n161 render probe', severity: 'high', reported_at: 'not-a-date' }, C.C16.site);
  } catch (err) {
    incidentThrew = fmt(err);
  }
  check('C16.1', incidentThrew === '', `incident alert with a failing render ${incidentThrew ? `threw (${incidentThrew})` : 'resolved'}`);
  check('C16.2', attempts.filter((m) => toList(m).some((t) => t === A.K16a || t === A.K16b)).length === 0, 'no incident message went out');
  const renderCaps = sentry.filter((e) => e.kind === 'exception' && e.ctx?.tags?.flow === 'incident_alert' && e.ctx?.tags?.stage === 'render');
  check('C16.3', renderCaps.length === 1, `incident render failures captured under stage=render: ${renderCaps.length} (expected 1 per call)`);
  check('C16.4', sgFail(mark16.s, mark16.l, 'incident_alert') === 0, `incident render failure: SendGrid-failure reports ${sgFail(mark16.s, mark16.l, 'incident_alert')}`);

  // Job run 1.
  RUN = 1;
  await jobFn!();
  check('C1.1', reached('C1', 'K1', 1) === 1, `K1 reached ${reached('C1', 'K1', 1)}`);
  check('C1.2', await flagged('C1'), 'C1 flagged');
  check('C2.1', reached('C2', 'K2', 1) === 1, `client_sites-only client (the Bethel case) reached ${reached('C2', 'K2', 1)}`);
  check('C2.2', await flagged('C2'), 'C2 flagged');
  check('C3.1', reached('C3', 'K3a', 1) === 1 && reached('C3', 'K3b', 1) === 1, `two clients: K3a ${reached('C3', 'K3a', 1)}, K3b ${reached('C3', 'K3b', 1)}`);
  const own = (label: string, first: string, otherFirst: string): boolean => {
    const mine = delivered.filter((m) => m.run === 1 && forCase(m, 'C3') && toList(m).length === 1 && toList(m)[0] === A[label]);
    return mine.length === 1 && mine[0].html.includes(first) && !mine[0].html.includes(otherFirst);
  };
  check('C3.2', own('K3a', 'Alda', 'Brio') && own('K3b', 'Brio', 'Alda'), 'each C3 recipient got its own message greeting its own name');
  check('C3.3', await flagged('C3'), 'C3 flagged');
  check('C4.1', deliveredFor('C4') === 0, `inactive-only: ${deliveredFor('C4')} delivered`);
  check('C4.2', !(await flagged('C4')), 'C4 not flagged');
  check('C5.1', reached('C5', 'K5a', 1) === 1 && reached('C5', 'K5b') === 0, `active primary ${reached('C5', 'K5a', 1)}, inactive junction ${reached('C5', 'K5b')}`);
  check('C6.1', deliveredFor('C6') === 0, `no client yet: ${deliveredFor('C6')} delivered`);
  check('C6.1b', !(await flagged('C6')), 'C6 not flagged after run 1');
  check('C7.1', reached('C7', 'K7') === 0, `client whose primary site was unlinked: reached ${reached('C7', 'K7')}`);
  check('C7.2', !(await flagged('C7')), 'C7 not flagged');
  check('C8.1', reached('C8', 'KB') === 0, `other tenant's client_sites row: reached ${reached('C8', 'KB')}`);
  check('C8.2', !(await flagged('C8')), 'C8 not flagged');
  check('C9.1', reached('C9', 'K9') === 0, `client access disabled: reached ${reached('C9', 'K9')}`);
  check('C9.2', !(await flagged('C9')), 'C9 not flagged');
  check('C10.1', reached('C10', 'K10') === 0, `company inactive: reached ${reached('C10', 'K10')}`);
  check('C10.2', !(await flagged('C10')), 'C10 not flagged');
  check('C11.1', reached('C11', 'K11a', 1) === 1 && attempted('C11', 'K11b') >= 1 && reached('C11', 'K11b') === 0,
    `partial: K11a delivered ${reached('C11', 'K11a', 1)}, K11b attempted ${attempted('C11', 'K11b')} and rejected`);
  check('C11.2', await flagged('C11'), 'C11 flagged (one recipient got it)');
  check('C11.3', logLines(1).some((l) => l.includes('SENDGRID ERROR') && l.includes(A.K11b)), "K11b's rejection logged as a SendGrid error");
  check('C12.1', attempted('C12', 'K12') === 1 && deliveredFor('C12') === 0 && !(await flagged('C12')), `all failed: ${attempted('C12', 'K12')} attempt, not flagged`);
  check('C12.2', logLines(1).some((l) => l.startsWith('[daily-email] Failed for shift') && l.includes(C.C12.shift!)), 'job logged C12 as failed');
  check('C12.3', logLines(1).some((l) => l.includes('SENDGRID ERROR') && l.includes(A.K12)), "K12's rejection logged as a SendGrid error");
  check('C14.1', deliveredFor('C14') === 0 && attempts.filter((m) => forCase(m, 'C14')).length === 0 && !(await flagged('C14')), 'render failure: no message, not flagged');
  check('C14.2', !logLines(1).some((l) => l.includes('SENDGRID ERROR') && l.includes(A.K14)) && !sentryFor('C14', 1).some((e) => e.ctx?.tags?.service === 'sendgrid'),
    `render failure not reported as SendGrid (tags ${JSON.stringify(sentryFor('C14', 1).map((e) => e.ctx?.tags))})`);
  const d1 = doneLine(1);
  check('F.2', !!d1 && same(d1, { sent: 5, partial: 1, skipped: 6, reasons: d1.reasons, failed: 2, ok: 6, bad: 3 })
    && same(Object.fromEntries(Object.entries(d1.reasons).sort()), { client_access_disabled: 1, company_inactive: 1, no_client: 4 }),
    `run 1: ${logLines(1).find((l) => l.startsWith('[daily-email] Done')) ?? 'no Done line'}`);
  // One event per failed shift, carrying the ORIGINAL error (not the wrapper).
  const ev12 = sentryFor('C12', 1);
  const ev14 = sentryFor('C14', 1);
  check('F.4', ev12.length === 1 && same(ev12[0].ctx?.tags, { flow: 'daily_shift_report', stage: 'send', service: 'sendgrid' })
    && ev12[0].value?.message === 'stub rejection'
    && ev14.length === 1 && same(ev14[0].ctx?.tags, { flow: 'daily_shift_report', stage: 'render' }) && ev14[0].value?.name === 'RangeError',
    `C12 ${ev12.length} event(s) ${JSON.stringify(ev12.map((e) => [e.value?.name, e.ctx?.tags]))}; C14 ${ev14.length} event(s) ${JSON.stringify(ev14.map((e) => [e.value?.name, e.ctx?.tags]))}`);
  const skips = logLines(1).filter((l) => l.startsWith('[email] sendDailyShiftReport: skipped — '));
  const count = (phrase: string): number => skips.filter((l) => l.includes(`skipped — ${phrase} for site`)).length;
  check('F.5', count('no active client') === 4 && count('client access disabled') === 1 && count('company inactive') === 1,
    `run-1 skip lines: no client ${count('no active client')}, access disabled ${count('client access disabled')}, company inactive ${count('company inactive')}`);

  // A client linked inside the window gets the report on the next run.
  await q('INSERT INTO client_sites (client_id, site_id) SELECT id, $1 FROM clients WHERE email = $2', [C.C6.site, A.K6]);

  // Job run 2.
  RUN = 2;
  await jobFn!();
  check('C6.2', reached('C6', 'K6', 2) === 1 && (await flagged('C6')), `after linking: K6 reached ${reached('C6', 'K6', 2)}, flagged ${await flagged('C6')}`);
  const resent = ['C1:K1', 'C2:K2', 'C3:K3a', 'C3:K3b', 'C5:K5a', 'C11:K11a'].filter((p) => { const [k, l] = p.split(':'); return reached(k, l, 2) > 0; });
  check('RUN2.1', resent.length === 0, `run 2 re-sent: ${resent.join(', ') || 'nothing'}`);
  const run2 = delivered.filter((m) => m.run === 2);
  check('RUN2.2', run2.length === 1 && reached('C6', 'K6', 2) === 1, `run 2 delivered ${run2.length} message(s)`);
  const d2 = doneLine(2);
  check('F.3', !!d2 && same(d2, { sent: 1, partial: 0, skipped: 5, reasons: d2.reasons, failed: 2, ok: 1, bad: 2 })
    && same(Object.fromEntries(Object.entries(d2.reasons).sort()), { client_access_disabled: 1, company_inactive: 1, no_client: 3 }),
    `run 2: ${logLines(2).find((l) => l.startsWith('[daily-email] Done')) ?? 'no Done line'}`);

  check('C15', attempts.every((m) => typeof m.to === 'string'), `every message has exactly one recipient (${attempts.length} attempts)`);
  const inv: string[] = [];
  for (const k of ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C14']) {
    if ((await flagged(k)) !== deliveredFor(k) > 0) inv.push(`${k} flagged=${await flagged(k)} delivered=${deliveredFor(k)}`);
  }
  check('INV.1', inv.length === 0, `flagged exactly when delivered: ${inv.join('; ') || 'all consistent'}`);

  // ── Verdict ──
  await pool.end();
  for (const r of results) out(`${r.pass === null ? 'N/A ' : r.pass ? 'PASS' : 'FAIL'} ${r.id.padEnd(6)} ${r.detail}`.slice(0, 400));
  const failing = results.filter((r) => r.pass === false).map((r) => r.id).sort();
  const want = predicted(MODE).slice().sort();
  out(`MODE ${MODE}${MUTATIONS[MODE] ? ` (${MUTATIONS[MODE].what})` : ''}: ${results.filter((r) => r.pass).length} pass, ${failing.length} fail, ${results.filter((r) => r.pass === null).length} n/a`);
  out(`FAILING   ${failing.join(',') || '-'}`);
  out(`PREDICTED ${want.join(',') || '-'}`);
  const ok = same(failing, want);
  out(ok ? 'RESULT AS PREDICTED' : 'RESULT NOT AS PREDICTED');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  out(`HARNESS ERROR ${fmt(err)}`);
  for (const l of logs.slice(-15)) out(`  log: ${l.line.slice(0, 300)}`);
  process.exit(3);
});
