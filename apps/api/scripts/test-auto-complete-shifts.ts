/**
 * test-auto-complete-shifts.ts — regression test for jobs/autoCompleteShifts.ts
 * (U4a: an auto clock-out records GREATEST(clocked_in_at, scheduled_end), not
 * the sweep time).
 *
 * LOCAL DATABASES ONLY. The pool is built from PGHOST / PGPORT / PGDATABASE /
 * PGUSER, and the script REFUSES to run unless PGHOST is 127.0.0.1 or
 * localhost. It also refuses if DATABASE_URL is set to any other host: the
 * job module builds its own pool from DATABASE_URL (db/pool.ts), and this
 * script must never be one typo away from a real database. The previous
 * version of this file ran against DATABASE_URL — "the live DB".
 *
 * Point it at a throwaway database with the full migration chain replayed
 * (apps/api/src/db/migrate.ts). It writes its own company, site and guards,
 * and deletes them at the end unless --keep is passed.
 *
 * Usage:
 *   PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=guard_u4a PGUSER=tester \
 *     npx ts-node apps/api/scripts/test-auto-complete-shifts.ts
 *
 * Every due fixture shift ends at t0 - 45 min, so its sweep predicate
 * (scheduled_end + 30 min <= NOW()) holds; the recorded end must still be the
 * anchor, 45 minutes before the sweep ran. Cases:
 *   A on-time clock-in           -> out = scheduled_end
 *   B late clock-in              -> out = scheduled_end, hours from clock-in
 *   C early clock-in             -> out = scheduled_end, hours from scheduled_start
 *   D clock-in during the grace  -> out = clocked_in_at, 0 hours
 *   E open break started before the end  -> break_end = scheduled_end
 *   F open break started in the grace    -> zero-length at break_start
 *   G open violation born before the end -> resolved at the anchor, branch 'clocked_out_at'
 *   H open violation born in the grace   -> resolved at occurred_at, 0 min, branch 'grace'
 *   I open violation on a session an EARLIER close ended -> branch 'occurred_at'
 *   J due shift with no session  -> 'missed' (unchanged)
 *   K shift inside the grace     -> untouched (unchanged)
 *   then a re-run must change nothing.
 *
 * Assertions do not stop at the first failure: the negative control (this
 * file against the pre-U4a job) must show WHICH assertions fail.
 */
import { Pool, PoolClient } from 'pg';
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

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}

const MIN = 60_000;
const hours = (ms: number): number => ms / 3_600_000;
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

interface Fixture {
  companyId: string;
  siteId: string;
  guardIds: string[];
  shiftIds: string[];
}

async function main(): Promise<void> {
  refuseUnlessLocal();

  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: false,
  });

  // Imported only after the host check. Importing the job module schedules its
  // cron through runJob(); stop every node-cron task at once so no tick can run
  // underneath the test.
  const { autoCompleteOverdueShifts } = await import('../src/jobs/autoCompleteShifts');
  for (const task of cron.getTasks().values()) task.stop();

  const marker = `u4a-test-${Date.now().toString(36)}`;
  const fx: Fixture = { companyId: '', siteId: '', guardIds: [], shiftIds: [] };

  try {
    const t0Row = await pool.query<{ t0: Date }>(`SELECT date_trunc('second', NOW()) AS t0`);
    const t0 = t0Row.rows[0].t0.getTime();
    const at = (offsetMin: number): Date => new Date(t0 + offsetMin * MIN);

    // ── fixtures ──────────────────────────────────────────────────────────
    const co = await pool.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ($1) RETURNING id`, [marker]);
    fx.companyId = co.rows[0].id;
    const si = await pool.query<{ id: string }>(
      `INSERT INTO sites (company_id, name, address, contract_start, timezone)
       VALUES ($1, $2, 'test', CURRENT_DATE, 'America/Los_Angeles') RETURNING id`,
      [fx.companyId, `${marker}-site`]);
    fx.siteId = si.rows[0].id;

    async function guard(tag: string): Promise<string> {
      const g = await pool.query<{ id: string }>(
        `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
         VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
        [fx.companyId, `${marker}-${tag}`, `${marker}-${tag}@example.invalid`, `${marker}-${tag}`]);
      fx.guardIds.push(g.rows[0].id);
      return g.rows[0].id;
    }

    // Due window for every swept case: 6 h shift ending t0 - 45 min.
    const START = -405;
    const END = -45;

    async function shiftWithSession(tag: string, clockInMin: number | null, opts: {
      status?: 'active' | 'scheduled' | 'completed';
      startMin?: number; endMin?: number;
      closedAtMin?: number;           // pre-closed session (case I)
    } = {}): Promise<{ shiftId: string; sessionId: string | null; guardId: string }> {
      const guardId = await guard(tag);
      const startMin = opts.startMin ?? START;
      const endMin = opts.endMin ?? END;
      const sh = await pool.query<{ id: string }>(
        `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [fx.siteId, guardId, at(startMin), at(endMin), opts.status ?? 'active']);
      fx.shiftIds.push(sh.rows[0].id);
      if (clockInMin === null) return { shiftId: sh.rows[0].id, sessionId: null, guardId };
      const closed = opts.closedAtMin !== undefined;
      const ss = await pool.query<{ id: string }>(
        `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords,
                                     clocked_out_at, clock_out_reason, total_hours)
         VALUES ($1, $2, $3, $4, '0,0', $5, $6, $7) RETURNING id`,
        [sh.rows[0].id, guardId, fx.siteId, at(clockInMin),
         closed ? at(opts.closedAtMin!) : null,
         closed ? 'manual_no_photo' : null,
         closed ? hours((opts.closedAtMin! - Math.max(clockInMin, startMin)) * MIN) : null]);
      return { shiftId: sh.rows[0].id, sessionId: ss.rows[0].id, guardId };
    }

    const A = await shiftWithSession('A-ontime', START + 2);
    const B = await shiftWithSession('B-late', START + 40);
    const C = await shiftWithSession('C-early', START - 10);
    const D = await shiftWithSession('D-grace-clockin', END + 10);
    const E = await shiftWithSession('E-break-before-end', START + 1);
    const F = await shiftWithSession('F-break-in-grace', START + 1);
    const G = await shiftWithSession('G-viol-before-end', START + 1);
    const H = await shiftWithSession('H-viol-in-grace', START + 1);
    const I = await shiftWithSession('I-viol-after-earlier-close', START + 1,
                                     { status: 'completed', closedAtMin: END });
    const J = await shiftWithSession('J-missed', null, { status: 'scheduled' });
    const K = await shiftWithSession('K-inside-grace', -370, { startMin: -370, endMin: -10 });

    const brkE = await pool.query<{ id: string }>(
      `INSERT INTO break_sessions (shift_session_id, guard_id, site_id, break_start, break_type, planned_duration_minutes)
       VALUES ($1, $2, $3, $4, 'break', 30) RETURNING id`,
      [E.sessionId, E.guardId, fx.siteId, at(END - 10)]);
    const brkF = await pool.query<{ id: string }>(
      `INSERT INTO break_sessions (shift_session_id, guard_id, site_id, break_start, break_type, planned_duration_minutes)
       VALUES ($1, $2, $3, $4, 'break', 30) RETURNING id`,
      [F.sessionId, F.guardId, fx.siteId, at(END + 5)]);

    async function violation(s: { sessionId: string | null; guardId: string }, occurredMin: number): Promise<string> {
      const v = await pool.query<{ id: string }>(
        `INSERT INTO geofence_violations (shift_session_id, guard_id, site_id, violation_lat, violation_lng,
                                          occurred_at, position_source)
         VALUES ($1, $2, $3, 0, 0, $4, 'site') RETURNING id`,
        [s.sessionId, s.guardId, fx.siteId, at(occurredMin)]);
      return v.rows[0].id;
    }
    const vG = await violation(G, END - 20);
    const vH = await violation(H, END + 10);
    const vI = await violation(I, END + 20);

    console.log(`\n=== ${marker}: t0=${new Date(t0).toISOString()}, fixtures seeded ===\n`);

    // ── run the sweep, capturing the violation log lines ─────────────────
    const branches = new Map<string, string>();
    const realInfo = console.info;
    const runOnce = async (): Promise<Awaited<ReturnType<typeof autoCompleteOverdueShifts>>> => {
      console.info = (...args: unknown[]) => {
        if (args[0] === '[auto_complete_shifts.violation_resolved]') {
          const p = args[1] as { violation_id: string; branch: string };
          branches.set(p.violation_id, p.branch);
        }
        realInfo(...args);
      };
      const client: PoolClient = await pool.connect();
      try { return await autoCompleteOverdueShifts(client); }
      finally { client.release(); console.info = realInfo; }
    };

    const r1 = await runOnce();
    console.log(`\nfirst run: ${JSON.stringify(r1)}\n`);
    check(r1.shiftsClosed === 9,       `shiftsClosed = 9 (A-H + J) (got ${r1.shiftsClosed})`);
    check(r1.sessionsClosed === 8,     `sessionsClosed = 8 (A-H) (got ${r1.sessionsClosed})`);
    check(r1.breaksClosed === 2,       `breaksClosed = 2 (E, F) (got ${r1.breaksClosed})`);
    check(r1.violationsResolved === 3, `violationsResolved = 3 (G, H, I) (got ${r1.violationsResolved})`);

    type SessRow = { clocked_in_at: Date; clocked_out_at: Date | null; total_hours: number | null;
                     clock_out_reason: string | null; scheduled_end: Date; status: string };
    const sess = async (s: { sessionId: string | null }): Promise<SessRow> => (await pool.query<SessRow>(
      `SELECT ss.clocked_in_at, ss.clocked_out_at, ss.total_hours, ss.clock_out_reason, sh.scheduled_end, sh.status
         FROM shift_sessions ss JOIN shifts sh ON sh.id = ss.shift_id WHERE ss.id = $1`, [s.sessionId])).rows[0];
    const ms = (d: Date | null): number => (d ? d.getTime() : NaN);

    // A-D: the anchor and total_hours, against numbers derived from the fixture offsets
    const expectAnchor = async (label: string, s: { sessionId: string | null }, anchorMin: number, expectedHours: number) => {
      const row = await sess(s);
      check(ms(row.clocked_out_at) === t0 + anchorMin * MIN,
        `${label}: clocked_out_at = anchor ${at(anchorMin).toISOString()} (got ${row.clocked_out_at?.toISOString()})`);
      check(row.total_hours !== null && close(row.total_hours, expectedHours),
        `${label}: total_hours = ${expectedHours.toFixed(6)} (got ${row.total_hours})`);
      check(row.clock_out_reason === 'auto', `${label}: clock_out_reason = 'auto' (got ${row.clock_out_reason})`);
      check(row.status === 'completed', `${label}: shift status 'completed' (got ${row.status})`);
    };
    await expectAnchor('A on-time',        A, END,      hours((END - (START + 2)) * MIN));
    await expectAnchor('B late clock-in',  B, END,      hours((END - (START + 40)) * MIN));
    await expectAnchor('C early clock-in', C, END,      hours((END - START) * MIN));
    await expectAnchor('D grace clock-in', D, END + 10, 0);
    await expectAnchor('E',                E, END,      hours((END - (START + 1)) * MIN));
    await expectAnchor('F',                F, END,      hours((END - (START + 1)) * MIN));

    // The recorded end is not the sweep time: the sweep ran ~45 min after it.
    const aRow = await sess(A);
    check(ms(aRow.clocked_out_at) < Date.now() - 40 * MIN,
      `A: clocked_out_at is at least 40 min before the sweep ran (not NOW())`);

    // Breaks b and c
    type BrkRow = { break_start: Date; break_end: Date | null; duration_minutes: number | null; ended_by: string | null };
    const brk = async (id: string): Promise<BrkRow> => (await pool.query<BrkRow>(
      `SELECT break_start, break_end, duration_minutes, ended_by FROM break_sessions WHERE id = $1`, [id])).rows[0];
    const bE = await brk(brkE.rows[0].id);
    check(ms(bE.break_end) === t0 + END * MIN, `E (b): break started before the end closes AT the anchor (got ${bE.break_end?.toISOString()})`);
    check(bE.duration_minutes === 10, `E (b): duration_minutes = 10 (got ${bE.duration_minutes})`);
    check(bE.ended_by === 'auto_complete', `E (b): ended_by = 'auto_complete' (got ${bE.ended_by})`);
    const bF = await brk(brkF.rows[0].id);
    check(ms(bF.break_end) === ms(bF.break_start), `F (c): grace break is zero-length, break_end = break_start (got ${bF.break_end?.toISOString()})`);
    check(bF.duration_minutes === 0, `F (c): duration_minutes = 0 (got ${bF.duration_minutes})`);
    check(bF.ended_by === 'auto_complete', `F (c): ended_by = 'auto_complete' (got ${bF.ended_by})`);

    // Violations d, and the log branch
    type ViolRow = { occurred_at: Date; resolved_at: Date | null; duration_minutes: number | null };
    const viol = async (id: string): Promise<ViolRow> => (await pool.query<ViolRow>(
      `SELECT occurred_at, resolved_at, duration_minutes FROM geofence_violations WHERE id = $1`, [id])).rows[0];
    const rG = await viol(vG);
    check(ms(rG.resolved_at) === t0 + END * MIN, `G (d): born before the end, resolved AT the anchor (got ${rG.resolved_at?.toISOString()})`);
    check(rG.duration_minutes === 20, `G (d): duration_minutes = 20 (got ${rG.duration_minutes})`);
    check(branches.get(vG) === 'clocked_out_at', `G (d): log branch 'clocked_out_at' (got ${branches.get(vG)})`);
    const rH = await viol(vH);
    check(ms(rH.resolved_at) === ms(rH.occurred_at), `H (d): born in the grace, resolved at occurred_at (got ${rH.resolved_at?.toISOString()})`);
    check(rH.duration_minutes === 0, `H (d): duration_minutes = 0 (got ${rH.duration_minutes})`);
    check(branches.get(vH) === 'grace', `H (d): log branch 'grace', not a leak (got ${branches.get(vH)})`);
    const rI = await viol(vI);
    check(ms(rI.resolved_at) === ms(rI.occurred_at) && rI.duration_minutes === 0,
      `I: born after an earlier close, resolved at occurred_at with 0 min`);
    check(branches.get(vI) === 'occurred_at', `I: log branch 'occurred_at' (the ingress-leak signal survives) (got ${branches.get(vI)})`);

    // Completed vs missed, and the grace boundary, unchanged
    const jRow = await pool.query<{ status: string }>(`SELECT status FROM shifts WHERE id = $1`, [J.shiftId]);
    check(jRow.rows[0].status === 'missed', `J: due shift with no session -> 'missed' (got ${jRow.rows[0].status})`);
    const kRow = await sess(K);
    check(kRow.clocked_out_at === null && kRow.status === 'active',
      `K: shift still inside the grace is untouched (open, 'active')`);
    const iRow = await sess(I);
    check(ms(iRow.clocked_out_at) === t0 + END * MIN && iRow.clock_out_reason === 'manual_no_photo',
      `I: a session closed before the sweep keeps its own clock-out and reason`);

    // Invariants across every fixture row
    const inv = await pool.query<{ bad_sessions: string; bad_breaks: string; bad_viols: string }>(
      `SELECT
         (SELECT count(*) FROM shift_sessions ss JOIN shifts sh ON sh.id = ss.shift_id
           WHERE sh.site_id = $1 AND ss.clocked_out_at < ss.clocked_in_at)                          AS bad_sessions,
         (SELECT count(*) FROM break_sessions b WHERE b.site_id = $1 AND b.break_end < b.break_start) AS bad_breaks,
         (SELECT count(*) FROM geofence_violations v WHERE v.site_id = $1
             AND (v.resolved_at < v.occurred_at OR v.duration_minutes < 0))                        AS bad_viols`,
      [fx.siteId]);
    check(inv.rows[0].bad_sessions === '0', 'invariant: no clocked_out_at < clocked_in_at');
    check(inv.rows[0].bad_breaks === '0', 'invariant: no break_end < break_start');
    check(inv.rows[0].bad_viols === '0', 'invariant: no resolved_at < occurred_at, no negative duration');

    // ── re-run: a no-op ───────────────────────────────────────────────────
    const snapshot = async (): Promise<string> => (await pool.query<{ h: string }>(
      `SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
         SELECT 's' || ss::text AS x FROM shift_sessions ss WHERE ss.site_id = $1
         UNION ALL SELECT 'h' || sh::text FROM shifts sh WHERE sh.site_id = $1
         UNION ALL SELECT 'b' || b::text FROM break_sessions b WHERE b.site_id = $1
         UNION ALL SELECT 'v' || v::text FROM geofence_violations v WHERE v.site_id = $1) q`,
      [fx.siteId])).rows[0].h;
    const before = await snapshot();
    const r2 = await runOnce();
    console.log(`\nre-run: ${JSON.stringify(r2)}`);
    check(r2.shiftsClosed === 0 && r2.sessionsClosed === 0 && r2.breaksClosed === 0 && r2.violationsResolved === 0,
      're-run closes and resolves nothing');
    check((await snapshot()) === before, 're-run leaves every fixture row byte-identical');
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
