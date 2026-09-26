/**
 * test-payable-hours.ts — D19 Payable hours, end to end, on a THROWAWAY
 * LOCAL Postgres (U6).
 *
 * LOCAL DATABASES ONLY. Everything under test — the fragments, the hours
 * export builder, the routers — uses the APP pool (db/pool.ts), which is built
 * from DATABASE_URL and, when that is unset, falls back to PGHOST / PGPORT /
 * PGDATABASE / PGUSER. So the script REFUSES to run unless PGHOST is
 * 127.0.0.1 or localhost, refuses if DATABASE_URL points anywhere else, and
 * after importing the pool re-asserts that it carries no connection string.
 *
 * Sentry, the auth middleware, the email service and S3 are replaced in
 * require.cache before any router loads (the routes/_aiEnhance.test.ts
 * pattern): no event is sent, no .env is read by sentry.ts, no email or S3
 * client is built, and no JWT is needed — auth is not what is under test.
 * Run it from a checkout with no .env.
 *
 * Point it at a throwaway database with the full migration chain replayed
 * (apps/api/src/db/migrate.ts). It writes its own company, site and guards
 * and deletes them at the end unless --keep is passed.
 *
 * Usage (from apps/api):
 *   PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=u6test PGUSER=tester \
 *     npx ts-node scripts/test-payable-hours.ts
 *
 * EXPECTED VALUES ARE COMPUTED HERE, INDEPENDENTLY. Payable is
 * max(0, min(out, scheduled_end) − max(in, scheduled_start)) over the seeded
 * minute offsets, in JS; coverage, variance, flags and the handoff share are
 * the D19 rules written out below. Nothing here calls PAYABLE_HOURS_ROW_SQL,
 * the export builder's helpers or any other code under test to produce an
 * expectation. Every seeded duration is a whole number of minutes, and
 * m·100/60 is never an exact half, so 2-dp rounding has no ties to disagree
 * about.
 *
 * Modules under test are loaded as `any` so the SAME file runs against the
 * pre-D19 code (the negative control) and reports which assertions fail,
 * rather than failing to compile.
 *
 * Cases (minutes relative to t0 = NOW() truncated to the minute; scheduled
 * window [-480, -120] = 6 h unless stated):
 *   A early clock-in, 30-min break, 45-min violation -> actual 6.33, payable 6.00
 *   B late clock-out                  -> payable 6.00, actual 112.5 %: OVER at 100 % coverage
 *   C auto clock-out at the anchor    -> payable = actual 5.92, AUTO_CLOSED
 *   D late clock-in                   -> 4.50 / 4.50, 75 %: SHORT
 *   E early in, early out             -> actual 100 %, payable 75 %: SHORT only under D19
 *   F far early in, early out         -> actual 116.7 % OVER and payable 50 % SHORT, one row
 *   G handoff, window [-600, -120]    -> payable 3.00 + 5.00; share 3.00 / 5.00 by payable
 *   H handoff, all before its window  -> payable 0; share splits equally, not by actual
 *   I zero-length schedule            -> payable 0, NO_SCHEDULE, coverage blank
 *   J clock-in after the end (auto)   -> payable 0
 *   K open, inside its window         -> payable runs to NOW()
 *   L open, past its end              -> payable capped at the window, actual still growing
 */
import { createHash } from 'crypto';
import Module from 'node:module';
import cron from 'node-cron';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const KEEP = process.argv.includes('--keep');

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) {
    console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`);
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (url) {
    let urlHost = '';
    try { urlHost = new URL(url).hostname; } catch { urlHost = '(unparseable)'; }
    if (!LOCAL_HOSTS.has(urlHost)) {
      console.error(`REFUSING: DATABASE_URL points at ${urlHost}; unset it or point it at localhost.`);
      process.exit(2);
    }
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

/** Any property is a function that refuses: the module must never be used. */
function refusingModule(name: string): unknown {
  return new Proxy({ __esModule: true }, {
    get: (target, prop) => (prop in target
      ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the Payable test`); }),
  });
}

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }

const MIN = 60_000;
/** 2-dp hours from whole minutes. */
const h2 = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;
const num = (v: unknown): number => (v === null || v === undefined ? NaN : Number(v));
const near = (a: number, b: number, tol = 0.02): boolean => Math.abs(a - b) <= tol;
const fmt = (v: unknown): string => (v === undefined ? 'undefined' : JSON.stringify(v));

/**
 * Pre-D19 default fragment output, pinned from origin/main 1d6b60b. The
 * surfaces that stay on Actual call the fragments without options; these
 * hashes prove their SQL — and so their payloads — did not move.
 */
const DEFAULT_FRAGMENT_SHA256: Array<[string, (m: any) => string, string]> = [
  ['SHIFT_HOURS_SQL_FIELDS(ss, sh)', (m) => m.SHIFT_HOURS_SQL_FIELDS('ss', 'sh'),
   '1506cea7295e7da1f78df4c6175391ce5b2178830ee51bd76f67aa087f0a0c28'],
  ['SHIFT_HOURS_AGG_SQL_FIELDS(ss)', (m) => m.SHIFT_HOURS_AGG_SQL_FIELDS('ss'),
   '236eba9fc6ed870410a3132e2bc8e840d590a8f49a0f814ec208eaf4e6fdd8cb'],
  ['SHIFT_HOURS_AGG_SQL_FIELDS(ss, h_prefix)', (m) => m.SHIFT_HOURS_AGG_SQL_FIELDS('ss', 'h_prefix'),
   'cc9ce74c52668b2f9237570da9cee7a35408969732d4d0ad9c97a8743e6fd7af'],
];

// ── the seeded cases ───────────────────────────────────────────────────────

interface SessionSpec {
  key: string;          // e.g. 'G-a'
  inMin: number;
  outMin: number | null; // null = open
  reason?: string;
}
interface CaseSpec {
  key: string;
  startMin: number;
  endMin: number;
  status: 'completed' | 'active';
  sessions: SessionSpec[];
}

const W0 = -480;
const W1 = -120;
const CASES: CaseSpec[] = [
  { key: 'A', startMin: W0, endMin: W1, status: 'completed', sessions: [{ key: 'A', inMin: -500, outMin: -120, reason: 'manual_no_photo' }] },
  { key: 'B', startMin: W0, endMin: W1, status: 'completed', sessions: [{ key: 'B', inMin: -480, outMin: -75, reason: 'manual_no_photo' }] },
  { key: 'C', startMin: W0, endMin: W1, status: 'completed', sessions: [{ key: 'C', inMin: -475, outMin: -120, reason: 'auto' }] },
  { key: 'D', startMin: W0, endMin: W1, status: 'completed', sessions: [{ key: 'D', inMin: -390, outMin: -120, reason: 'manual_no_photo' }] },
  { key: 'E', startMin: W0, endMin: W1, status: 'completed', sessions: [{ key: 'E', inMin: -570, outMin: -210, reason: 'manual_no_photo' }] },
  { key: 'F', startMin: W0, endMin: W1, status: 'completed', sessions: [{ key: 'F', inMin: -720, outMin: -300, reason: 'manual_no_photo' }] },
  { key: 'G', startMin: -600, endMin: W1, status: 'completed', sessions: [
    { key: 'G-a', inMin: -610, outMin: -420, reason: 'handoff' },
    { key: 'G-b', inMin: -420, outMin: -100, reason: 'manual_no_photo' }] },
  { key: 'H', startMin: -300, endMin: -240, status: 'completed', sessions: [
    { key: 'H-a', inMin: -400, outMin: -360, reason: 'handoff' },
    { key: 'H-b', inMin: -360, outMin: -330, reason: 'manual_no_photo' }] },
  { key: 'I', startMin: -300, endMin: -300, status: 'completed', sessions: [{ key: 'I', inMin: -305, outMin: -180, reason: 'manual_no_photo' }] },
  { key: 'J', startMin: W0, endMin: W1, status: 'completed', sessions: [{ key: 'J', inMin: -110, outMin: -110, reason: 'auto' }] },
  { key: 'K', startMin: -120, endMin: 240, status: 'active', sessions: [{ key: 'K', inMin: -130, outMin: null }] },
  { key: 'L', startMin: -420, endMin: -60, status: 'active', sessions: [{ key: 'L', inMin: -420, outMin: null }] },
];

// ── the D19 rules, written out independently of services/hoursExport.ts ─────

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const covOf = (hours: number, scheduled: number): number | null =>
  (scheduled <= 0 ? null : round1((hours / scheduled) * 100));
function d19Flags(x: { actual: number; payable: number; scheduled: number; offpost: number; auto: boolean }): string[] {
  const out: string[] = [];
  const cp = covOf(x.payable, x.scheduled);
  const ca = covOf(x.actual, x.scheduled);
  if (x.scheduled <= 0)          out.push('NO_SCHEDULE');
  if (cp !== null && cp < 80)    out.push('SHORT');   // from PAYABLE
  if (ca !== null && ca > 110)   out.push('OVER');    // from ACTUAL
  if (x.auto)                    out.push('AUTO_CLOSED');
  if (x.offpost > x.actual)      out.push('OFFPOST_ANOMALY');
  return out;
}

/** A route handler stack driven directly — no express app, no listen (routes/_aiEnhance.test.ts). */
interface Captured { status: number; body: unknown; headers: Record<string, string> }
async function callRoute(router: any, path: string, req: Record<string, unknown>): Promise<Captured> {
  const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods.get);
  if (!layer) throw new Error(`GET ${path} not found on the router`);
  const out: Captured = { status: 200, body: undefined, headers: {} };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { out.body = payload; return res; },
    send(payload: unknown) { out.body = payload; return res; },
    setHeader(k: string, v: string) { out.headers[k] = v; },
  };
  const fullReq: any = { query: {}, params: {}, body: {}, headers: {}, ...req };
  for (const h of layer.route.stack.map((s: any) => s.handle)) {
    let advanced = false;
    await h(fullReq, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return out;
}

/** Independent Payable, in minutes, at wall-clock offset `nowMin` for open sessions. */
function payableMin(c: CaseSpec, s: SessionSpec, nowMin: number): number {
  const out = s.outMin ?? nowMin;
  return Math.max(0, Math.min(out, c.endMin) - Math.max(s.inMin, c.startMin));
}
function actualMin(s: SessionSpec, nowMin: number): number {
  return Math.max(0, (s.outMin ?? nowMin) - s.inMin);
}

interface Seeded {
  companyId: string;
  siteId: string;
  guardBySession: Map<string, string>;
  sessionId: Map<string, string>;
  shiftId: Map<string, string>;
  t0: number;
}

async function main(): Promise<void> {
  refuseUnlessLocal();

  // Stubs first: nothing below may load the real Sentry, auth, email or S3.
  inject('../src/services/sentry', {
    Sentry: {
      captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined,
      withScope: (fn: (s: unknown) => void) => fn({ setTag: () => undefined, setExtra: () => undefined }),
    },
  });
  let actor: Record<string, unknown> = {};
  inject('../src/middleware/auth', {
    requireAuth: () => (req: any, _res: unknown, next: () => void) => { req.user = actor; next(); },
    secretForRole: () => 'test-only',
  });
  inject('../src/services/email', refusingModule('email'));
  inject('../src/services/s3', refusingModule('s3'));

  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) {
    console.error('REFUSING: the app pool carries a connection string; unset DATABASE_URL.');
    process.exit(2);
  }
  const sh: any = await import('../src/services/shiftHours');
  for (const task of cron.getTasks().values()) task.stop();

  const marker = `u6-test-${Date.now().toString(36)}`;
  const fx: Seeded = {
    companyId: '', siteId: '', guardBySession: new Map(), sessionId: new Map(), shiftId: new Map(), t0: 0,
  };

  try {
    const t0Row = await pool.query(`SELECT date_trunc('minute', NOW()) AS t0`);
    fx.t0 = (t0Row.rows[0].t0 as Date).getTime();
    const at = (m: number): Date => new Date(fx.t0 + m * MIN);
    const nowMin = async (): Promise<number> =>
      ((await pool.query(`SELECT NOW() AS n`)).rows[0].n.getTime() - fx.t0) / MIN;

    // ── fixtures ──────────────────────────────────────────────────────────
    fx.companyId = (await pool.query(
      `INSERT INTO companies (name) VALUES ($1) RETURNING id`, [marker])).rows[0].id;
    fx.siteId = (await pool.query(
      `INSERT INTO sites (company_id, name, address, contract_start, timezone)
       VALUES ($1, $2, 'test', CURRENT_DATE, 'America/Los_Angeles') RETURNING id`,
      [fx.companyId, `${marker}-site`])).rows[0].id;

    for (const c of CASES) {
      const guardIds: string[] = [];
      for (const s of c.sessions) {
        const g = await pool.query(
          `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
           VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
          [fx.companyId, `${marker}-${s.key}`, `${marker}-${s.key}@example.invalid`, `U6-${s.key}`]);
        guardIds.push(g.rows[0].id);
        fx.guardBySession.set(s.key, g.rows[0].id);
      }
      // The shift belongs to its LAST guard, as after a handoff.
      const shiftId = (await pool.query(
        `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [fx.siteId, guardIds[guardIds.length - 1], at(c.startMin), at(c.endMin), c.status])).rows[0].id;
      fx.shiftId.set(c.key, shiftId);
      for (const s of c.sessions) {
        const ss = await pool.query(
          `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords,
                                       clocked_out_at, clock_out_reason)
           VALUES ($1, $2, $3, $4, '0,0', $5, $6) RETURNING id`,
          [shiftId, fx.guardBySession.get(s.key), fx.siteId, at(s.inMin),
           s.outMin === null ? null : at(s.outMin), s.outMin === null ? null : s.reason ?? null]);
        fx.sessionId.set(s.key, ss.rows[0].id);
      }
    }
    // A: a 30-minute break inside the window, and a 45-minute violation with no pings.
    await pool.query(
      `INSERT INTO break_sessions (shift_session_id, guard_id, site_id, break_start, break_end, break_type, planned_duration_minutes)
       VALUES ($1, $2, $3, $4, $5, 'break', 30)`,
      [fx.sessionId.get('A'), fx.guardBySession.get('A'), fx.siteId, at(-300), at(-270)]);
    await pool.query(
      `INSERT INTO geofence_violations (shift_session_id, guard_id, site_id, violation_lat, violation_lng,
                                        occurred_at, resolved_at, position_source)
       VALUES ($1, $2, $3, 0, 0, $4, $5, 'site')`,
      [fx.sessionId.get('A'), fx.guardBySession.get('A'), fx.siteId, at(-400), at(-355)]);

    const allSessions = CASES.flatMap((c) => c.sessions.map((s) => ({ c, s })));

    // ══ U1: the fragment and the types ══════════════════════════════════════
    section('U1 — PAYABLE_HOURS_ROW_SQL through the per-session fragment');
    {
      const r = await pool.query(
        `SELECT ss.id, EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms,
                ${sh.SHIFT_HOURS_SQL_FIELDS('ss', 'sh', { payable: true })}
           FROM shift_sessions ss JOIN shifts sh ON sh.id = ss.shift_id
          WHERE ss.site_id = $1`, [fx.siteId]);
      const byId = new Map(r.rows.map((row: any) => [row.id, row]));
      for (const { c, s } of allSessions) {
        const row: any = byId.get(fx.sessionId.get(s.key));
        const nowM = (Number(row.now_ms) - fx.t0) / MIN;
        const want = s.outMin === null ? payableMin(c, s, nowM) / 60 : h2(payableMin(c, s, 0));
        const tol = s.outMin === null && payableMin(c, s, nowM) < c.endMin - c.startMin ? 0.02 : 0;
        check(near(num(row.payable_hours), want, tol),
          `${s.key}: payable_hours ${fmt(row.payable_hours)} = ${want.toFixed(2)}`);
        if (s.outMin !== null) {
          check(num(row.actual_hours) === h2(actualMin(s, 0)),
            `${s.key}: actual_hours ${fmt(row.actual_hours)} = ${h2(actualMin(s, 0))} (raw, unchanged)`);
        }
        if (row.payable_hours !== undefined) {
          const sched = (c.endMin - c.startMin) / 60;
          check(num(row.payable_hours) <= num(row.actual_hours) + 0.005,
            `${s.key}: payable ≤ actual`);
          if (sched >= 0) check(num(row.payable_hours) <= sched + 0.005, `${s.key}: payable ≤ scheduled`);
        }
      }
      check(Object.keys(r.rows[0]).indexOf('payable_hours') === Object.keys(r.rows[0]).indexOf('actual_hours') + 1,
        'payable_hours is the column right after actual_hours');
    }

    section('U1 — the aggregate fragment (per shift; handoffs sum their sessions)');
    for (const naming of ['hours_suffix', 'h_prefix'] as const) {
      const col = naming === 'h_prefix' ? 'h_payable' : 'payable_hours';
      const r = await pool.query(
        `SELECT ss.shift_id, ${sh.SHIFT_HOURS_AGG_SQL_FIELDS('ss', naming, 'sh', { payable: true })}
           FROM shift_sessions ss JOIN shifts sh ON sh.id = ss.shift_id
          WHERE ss.site_id = $1 AND ss.clocked_out_at IS NOT NULL
          GROUP BY ss.shift_id`, [fx.siteId]);
      const byShift = new Map(r.rows.map((row: any) => [row.shift_id, row]));
      for (const c of CASES.filter((x) => x.status === 'completed')) {
        const want = h2(c.sessions.reduce((a, s) => a + payableMin(c, s, 0), 0));
        const row: any = byShift.get(fx.shiftId.get(c.key));
        check(num(row?.[col]) === want, `${naming} ${c.key}: ${col} ${fmt(row?.[col])} = ${want}`);
      }
    }

    section('U1 — without { payable: true } the fragments are byte-identical to pre-D19');
    for (const [label, gen, want] of DEFAULT_FRAGMENT_SHA256) {
      const got = createHash('sha256').update(gen(sh)).digest('hex');
      check(got === want, `${label} sha256 ${got.slice(0, 12)} = ${want.slice(0, 12)}`);
    }
    {
      const plain = await pool.query(
        `SELECT ${sh.SHIFT_HOURS_SQL_FIELDS('ss', 'sh')} FROM shift_sessions ss JOIN shifts sh ON sh.id = ss.shift_id LIMIT 1`);
      check(!('payable_hours' in plain.rows[0]), 'the default per-session fragment emits no payable_hours');
    }

    section('U1 — types and helpers');
    {
      const k = await sh.getShiftHours({ shift_session_id: fx.sessionId.get('K') });
      check(JSON.stringify(Object.keys(k).sort()) === JSON.stringify(['actual_hours', 'break_hours', 'scheduled_hours', 'violation_hours']),
        `getShiftHours (mobile active-session) returns the 4 Actual fields only: ${Object.keys(k).join(',')}`);
      const empty = typeof sh.emptyPayableShiftHours === 'function' ? sh.emptyPayableShiftHours() : undefined;
      check(empty?.payable_hours === 0, `emptyPayableShiftHours().payable_hours = 0 (${fmt(empty?.payable_hours)})`);
      const sum = sh.sumShiftHours([
        { scheduled_hours: 6, actual_hours: 6.33, payable_hours: 6, break_hours: 0.5, violation_hours: 0.75 },
        { scheduled_hours: 8, actual_hours: 3.17, payable_hours: 3, break_hours: 0, violation_hours: 0 },
      ]);
      check(sum.payable_hours === 9 && sum.actual_hours === 9.5,
        `sumShiftHours sums payable ${fmt(sum.payable_hours)} = 9 alongside actual ${fmt(sum.actual_hours)} = 9.5`);
      const nm = await nowMin();
      check(nm >= 0, `clock sanity: NOW() is ${nm.toFixed(2)} min after t0`);
    }

    // ══ U2: the hours export and its workbook ═══════════════════════════════
    const hx: any = await import('../src/services/hoursExport');
    const hw: any = await import('../src/services/hoursWorkbook');
    const ExcelJS: any = (await import('exceljs')).default;
    const closed = allSessions.filter(({ s }) => s.outMin !== null);
    const offpostBy: Record<string, number> = { A: 0.75 };
    const expectRow = (c: CaseSpec, s: SessionSpec) => {
      const scheduled = round2((c.endMin - c.startMin) / 60);
      const actual = h2(actualMin(s, 0));
      const payable = h2(payableMin(c, s, 0));
      const offpost = offpostBy[s.key] ?? 0;
      return {
        scheduled, actual, payable, offpost,
        variance: round2(payable - scheduled),
        coverage: covOf(payable, scheduled),
        flags: d19Flags({ actual, payable, scheduled, offpost, auto: s.reason === 'auto' }),
      };
    };

    section('U2 — buildHoursExport rows: payable, variance, coverage and flags per D19');
    const data = await hx.buildHoursExport({ company_id: fx.companyId, site_id: fx.siteId });
    {
      check(data.rows.length === closed.length, `${data.rows.length} rows = ${closed.length} closed sessions (open K, L excluded)`);
      const bySession = new Map(data.rows.map((r: any) => [r.session_id, r]));
      for (const { c, s } of closed) {
        const r: any = bySession.get(fx.sessionId.get(s.key));
        const e = expectRow(c, s);
        check(r?.payable_hours === e.payable, `${s.key}: payable ${fmt(r?.payable_hours)} = ${e.payable}`);
        check(r?.actual_hours === e.actual, `${s.key}: actual ${fmt(r?.actual_hours)} = ${e.actual}`);
        check(r?.variance_hours === e.variance, `${s.key}: variance ${fmt(r?.variance_hours)} = payable − scheduled = ${e.variance}`);
        check(r?.coverage_pct === e.coverage, `${s.key}: coverage ${fmt(r?.coverage_pct)} = ${fmt(e.coverage)}`);
        check(JSON.stringify(r?.flags) === JSON.stringify(e.flags), `${s.key}: flags ${fmt(r?.flags)} = ${fmt(e.flags)}`);
      }
      // The two discriminating rows, stated literally as well as by rule.
      const E = bySession.get(fx.sessionId.get('E')) as any;
      const F = bySession.get(fx.sessionId.get('F')) as any;
      check(JSON.stringify(E?.flags) === '["SHORT"]', `E is SHORT on Payable (75 %) though Actual is 100 %: ${fmt(E?.flags)}`);
      check(JSON.stringify(F?.flags) === '["SHORT","OVER"]', `F is SHORT on Payable and OVER on Actual at once: ${fmt(F?.flags)}`);
      const B = bySession.get(fx.sessionId.get('B')) as any;
      check(B?.coverage_pct === 100 && JSON.stringify(B?.flags) === '["OVER"]',
        `B is OVER with coverage 100 %: coverage ${fmt(B?.coverage_pct)}, flags ${fmt(B?.flags)}`);
      const keys = Object.keys(data.rows[0] ?? {});
      check(keys.indexOf('payable_hours') === keys.indexOf('actual_hours') + 1, 'row key order: payable_hours right after actual_hours');
    }

    section('U2 — aggregates: payable totals, the handoff share by payable, the invariant');
    {
      const guardAgg = (key: string) => data.by_guard.find((a: any) => a.guard_id === fx.guardBySession.get(key));
      // G: 8 h window, payable 3 + 5 -> shares 3 / 5 (by actual it would be 2.98 / 5.02).
      check(guardAgg('G-a')?.scheduled_hours === 3 && guardAgg('G-b')?.scheduled_hours === 5,
        `G handoff share by payable: ${fmt(guardAgg('G-a')?.scheduled_hours)} / ${fmt(guardAgg('G-b')?.scheduled_hours)} = 3 / 5`);
      // H: payable 0 on both sides -> equal split (by actual it would be 0.57 / 0.43).
      check(guardAgg('H-a')?.scheduled_hours === 0.5 && guardAgg('H-b')?.scheduled_hours === 0.5,
        `H handoff with shift payable 0 splits equally: ${fmt(guardAgg('H-a')?.scheduled_hours)} / ${fmt(guardAgg('H-b')?.scheduled_hours)} = 0.5 / 0.5`);
      const wantPay = round2(closed.reduce((a, { c, s }) => a + expectRow(c, s).payable, 0));
      const wantAct = round2(closed.reduce((a, { c, s }) => a + expectRow(c, s).actual, 0));
      const wantSched = round2(CASES.filter((c) => c.status === 'completed')
        .reduce((a, c) => a + (c.endMin - c.startMin) / 60, 0));
      const o = data.overall;
      check(o.payable_hours === wantPay, `overall payable ${fmt(o.payable_hours)} = ${wantPay}`);
      check(o.actual_hours === wantAct, `overall actual ${fmt(o.actual_hours)} = ${wantAct} (unchanged, raw)`);
      check(o.scheduled_hours === wantSched, `overall scheduled ${fmt(o.scheduled_hours)} = ${wantSched} (shares sum to each window)`);
      check(o.variance_hours === round2(wantPay - wantSched), `overall variance ${fmt(o.variance_hours)} = ${round2(wantPay - wantSched)}`);
      check(o.coverage_pct === covOf(wantPay, wantSched), `overall coverage ${fmt(o.coverage_pct)} = ${fmt(covOf(wantPay, wantSched))}`);
      const wantFlagged = new Set(closed.filter(({ c, s }) => expectRow(c, s).flags.length > 0).map(({ c }) => c.key)).size;
      check(o.flagged_count === wantFlagged, `overall flagged shifts ${fmt(o.flagged_count)} = ${wantFlagged}`);
      for (const f of ['scheduled_hours', 'actual_hours', 'payable_hours', 'break_hours', 'offpost_hours']) {
        const sum = (xs: any[]) => round2(xs.reduce((a, x) => a + (x[f] ?? NaN), 0));
        const g = sum(data.by_guard), si = sum(data.by_site), gs = sum(data.by_guard_site), ov = round2(o[f]);
        check(g === ov && si === ov && gs === ov, `Σ by_guard ${g} = Σ by_site ${si} = Σ by_guard_site ${gs} = overall ${ov} (${f})`);
      }
    }

    section('U2 — the workbook: columns, derived positions, fills, NOTES');
    {
      const buf = await hw.workbookToBuffer(hw.buildHoursWorkbook(data));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const DETAIL = ['Guard', 'Site', 'Date', 'Day', 'Sched Start', 'Sched End', 'Clock In', 'Clock Out',
        'Scheduled', 'Actual', 'Payable', 'Break', 'Geofence violation', 'Variance', 'Coverage %', 'Flag'];
      const rowVals = (ws: any, n: number): unknown[] => (ws.getRow(n).values as unknown[]).slice(1);
      const d = wb.getWorksheet('HOURS DETAIL');
      check(JSON.stringify(rowVals(d, 1)) === JSON.stringify(DETAIL), `HOURS DETAIL header = ${DETAIL.length} columns, Payable at 11`);
      let fRow: any = null;
      d.eachRow((row: any) => { if (row.getCell(1).value === `${marker}-F`) fRow = row; });
      const eF = expectRow(CASES.find((c) => c.key === 'F')!, CASES.find((c) => c.key === 'F')!.sessions[0]);
      check(fRow?.getCell(10).value === eF.actual && fRow?.getCell(11).value === eF.payable,
        `F detail row: Actual ${fmt(fRow?.getCell(10).value)} = ${eF.actual}, Payable ${fmt(fRow?.getCell(11).value)} = ${eF.payable}`);
      check(fRow?.getCell(14).value === eF.variance, `F detail row: Variance (col 14) ${fmt(fRow?.getCell(14).value)} = ${eF.variance}`);
      check(fRow?.getCell(15).value === 0.5 && fRow?.getCell(15).numFmt === '0.0%',
        `F detail row: Coverage (col 15) ${fmt(fRow?.getCell(15).value)} as 0.0% = 0.5`);
      check(fRow?.getCell(15).fill?.fgColor?.argb === 'FFF8D2D2', 'F detail row: coverage cell RED (< 80 %)');
      check(fRow?.getCell(16).value === 'SHORT OVER' && fRow?.getCell(16).fill?.fgColor?.argb === 'FFF8D2D2',
        `F detail row: Flag (col 16) ${fmt(fRow?.getCell(16).value)} with a red fill`);
      check(fRow?.getCell(12).fill === undefined || fRow?.getCell(12).fill?.fgColor?.argb === undefined,
        'F detail row: no fill on Break (col 12) — the RAG fill did not land one column short');
      let total: any = null;
      d.eachRow((row: any) => { if (row.getCell(1).value === 'TOTAL') total = row; });
      check(total?.getCell(9).value === data.overall.scheduled_hours && total?.getCell(11).value === data.overall.payable_hours,
        `DETAIL TOTAL: Scheduled (col 9) ${fmt(total?.getCell(9).value)}, Payable (col 11) ${fmt(total?.getCell(11).value)}`);
      check(total?.getCell(15).value === data.overall.coverage_pct / 100, 'DETAIL TOTAL: coverage in col 15');
      const e = wb.getWorksheet('EXCEPTIONS');
      check(JSON.stringify(rowVals(e, 3)) === JSON.stringify(DETAIL), 'EXCEPTIONS header matches HOURS DETAIL');
      check(String(e.getRow(1).getCell(1).value).includes('SHORT: payable coverage < 80%'),
        'EXCEPTIONS rule banner: SHORT is payable coverage');
      const s = wb.getWorksheet('SUMMARY');
      check(JSON.stringify(rowVals(s, 4).slice(0, 8)) === JSON.stringify(
        ['Shifts', 'Scheduled h', 'Actual h', 'Payable h', 'Coverage %', 'Break h', 'Geofence violation h', 'Flagged']),
        'SUMMARY KPI header has Payable h after Actual h');
      check(s.getRow(5).getCell(4).value === data.overall.payable_hours && s.getRow(5).getCell(5).numFmt === '0.0%',
        `SUMMARY KPI: Payable ${fmt(s.getRow(5).getCell(4).value)} in col 4, coverage in col 5`);
      check(JSON.stringify(rowVals(s, 8)) === JSON.stringify(
        ['Guard', 'Site', 'Shifts', 'Scheduled', 'Actual', 'Payable', 'Variance', 'Coverage %', 'Break', 'Geofence violation', 'Flagged']),
        'SUMMARY BY GUARD & SITE header has Payable after Actual');
      check(s.getRow(9).getCell(8).numFmt === '0.0%', 'SUMMARY BY GUARD & SITE: coverage in col 8');
      const n = wb.getWorksheet('NOTES');
      const notes = new Map<string, string>();
      n.eachRow((row: any) => { notes.set(String(row.getCell(1).value ?? ''), String(row.getCell(2).value ?? '')); });
      check((notes.get('Payable') ?? '').startsWith('Clocked-in time inside the scheduled window'), 'NOTES has a Payable row');
      check((notes.get('Variance') ?? '').startsWith('Payable minus scheduled'), 'NOTES: Variance is Payable minus scheduled');
      check((notes.get('Coverage %') ?? '').startsWith('Payable as a percentage of scheduled'), 'NOTES: Coverage % is Payable-based');
      check(notes.get('SHORT') === 'Payable coverage below 80%.', 'NOTES: SHORT is payable coverage');
      check((notes.get('OVER') ?? '').startsWith('Actual above 110% of scheduled'), 'NOTES: OVER stays on Actual');
      check((notes.get('Scheduled') ?? '').includes('in proportion to payable hours'), 'NOTES: the share splits by payable');
      check((notes.get('Break') ?? '').includes('not subtracted from Payable'), 'NOTES: breaks are not subtracted');
    }

    section('U2 — GET /api/billing/hours-export (the on-demand route; the monthly job uses the same builder)');
    {
      const billing: any = (await import('../src/routes/billing')).default;
      actor = { sub: 'admin-test', role: 'company_admin', company_id: fx.companyId };
      const out = await callRoute(billing, '/hours-export', { query: { site_id: fx.siteId } });
      const wb = new ExcelJS.Workbook();
      let header: unknown[] = [];
      try { await wb.xlsx.load(out.body as Buffer); header = (wb.getWorksheet('HOURS DETAIL').getRow(1).values as unknown[]).slice(1); }
      catch (err) { console.log(`  (could not read the route's workbook: ${(err as Error).message})`); }
      check(out.status === 200 && header[10] === 'Payable', `route workbook HOURS DETAIL col 11 = ${fmt(header[10])}`);
    }

    // ══ later units append their sections here ══════════════════════════════
  } finally {
    if (!KEEP && fx.companyId) {
      await pool.query(`DELETE FROM geofence_violations WHERE site_id = $1`, [fx.siteId]);
      await pool.query(`DELETE FROM break_sessions WHERE site_id = $1`, [fx.siteId]);
      await pool.query(`DELETE FROM shift_sessions WHERE site_id = $1`, [fx.siteId]);
      await pool.query(`DELETE FROM shifts WHERE site_id = $1`, [fx.siteId]);
      await pool.query(`DELETE FROM guards WHERE company_id = $1`, [fx.companyId]);
      await pool.query(`DELETE FROM sites WHERE id = $1`, [fx.siteId]);
      await pool.query(`DELETE FROM companies WHERE id = $1`, [fx.companyId]);
      console.log(`\ncleaned up ${marker}`);
    } else if (KEEP) {
      console.log(`\nleft ${marker} in place (--keep)`);
    }
    await pool.end();
  }

  console.log(`\n=== ${passes} passed, ${failures} failed ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
