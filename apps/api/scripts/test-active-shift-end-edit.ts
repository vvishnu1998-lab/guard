/**
 * test-active-shift-end-edit.ts — U2 + U5 (D20), end to end on a THROWAWAY
 * LOCAL Postgres.
 *
 * U2: PATCH /api/shifts/:id moves an ACTIVE shift's end — extend, shorten to a
 * later-than-now end, or set it in the past, which closes the open session in
 * one transaction. U5: every create/edit path refuses end <= start and asks
 * for confirm_long_shift above 12 h. Plus the missed-window cron INSERT's
 * current-end re-check (decision 2a) and GET /api/shifts/:id's new fields.
 *
 * LOCAL DATABASES ONLY. The app pool (db/pool.ts) is built from DATABASE_URL
 * and falls back to PGHOST/PGPORT/PGDATABASE/PGUSER when that is unset; this
 * script REFUSES unless PGHOST is 127.0.0.1 or localhost, refuses if
 * DATABASE_URL points anywhere else, and re-asserts after import that the
 * pool carries no connection string. Point it at a database with the full
 * migration chain replayed (db/migrate.ts). It writes one company of its own
 * and removes it at the end unless --keep is passed.
 *
 * Sentry, auth, email, S3 and firebase are replaced in require.cache before
 * the router loads (the routes/_aiEnhance.test.ts / test-payable-hours.ts
 * pattern). The firebase stub RECORDS pushes instead of sending them, so the
 * guard-facing text is asserted on the push itself as well as on its
 * notifications row. No .env is read.
 *
 *   PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=u2test PGUSER=tester \
 *     npx ts-node scripts/test-active-shift-end-edit.ts          (from apps/api)
 *
 * EXPECTED VALUES ARE COMPUTED HERE from the seeded minute offsets — hours,
 * break and violation minutes, which missed rows survive — not by calling the
 * code under test. Modules under test are loaded as `any`, so the SAME file
 * runs against origin/main (the negative control) and reports which checks
 * fail instead of failing to compile. Checks never stop at the first failure.
 *
 * Offsets are minutes from t0 = the database's NOW() truncated to the second.
 * The whole run takes seconds; the one timing-sensitive case (G2, allowed
 * inside the grace) has four minutes of slack.
 */
import Module from 'node:module';
import cron from 'node-cron';
import { Client } from 'pg';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const KEEP = process.argv.includes('--keep');
const TZ = 'America/Los_Angeles';

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
function refusingModule(name: string): unknown {
  return new Proxy({ __esModule: true }, {
    get: (target, prop) => (prop in target
      ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the U2/U5 test`); }),
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
const ms = (v: unknown): number => (v === null || v === undefined ? NaN : new Date(v as string).getTime());
const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol;
const show = (v: unknown): string => JSON.stringify(v);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

interface Captured { status: number; body: any; threw?: unknown }
async function callRoute(router: any, method: 'get' | 'post' | 'patch', path: string, req: Record<string, unknown>): Promise<Captured> {
  const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} not found on the router`);
  const out: Captured = { status: 200, body: undefined };
  const res: any = {
    headersSent: false,
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { out.body = payload; res.headersSent = true; return res; },
    send(payload: unknown) { out.body = payload; res.headersSent = true; return res; },
    setHeader() { /* unused */ },
  };
  const fullReq: any = { query: {}, params: {}, body: {}, headers: {}, ...req };
  try {
    for (const h of layer.route.stack.map((s: any) => s.handle)) {
      let advanced = false;
      await h(fullReq, res, () => { advanced = true; });
      if (!advanced) break;
    }
  } catch (err) {
    out.threw = err;
    out.status = 500;
  }
  return out;
}

/** en-US strings at the site, written out here for the expected push text. */
function dayLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ }).format(d);
}
function timeLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).format(d);
}
/** 'Fri Sep 26, 06:00' built from parts, independently of constants/longShift.ts. */
function endsLabel(d: Date): string {
  const p = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('weekday')} ${g('month')} ${g('day')}, ${g('hour')}:${g('minute')}`;
}

async function main(): Promise<void> {
  refuseUnlessLocal();

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
  const pushes: Array<{ token: string; title: string; body: string; data: any }> = [];
  inject('../src/services/firebase', {
    sendPushNotification: async (p: any) => { pushes.push({ token: p.token, title: p.title, body: p.body, data: p.data }); },
    buildExpoPushMessage: () => ({}),
  });

  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) {
    console.error('REFUSING: the app pool carries a connection string; unset DATABASE_URL.');
    process.exit(2);
  }
  const router: any = (await import('../src/routes/shifts')).default;
  const sweepMod: any = await import('../src/jobs/autoCompleteShifts');
  const reminderMod: any = await import('../src/jobs/clockOutReminder');
  for (const task of cron.getTasks().values()) task.stop();
  let missedInsert: any = null;
  // A non-literal specifier, so this file still compiles against a tree that
  // lacks the module (origin/main, the negative control); the M checks then fail.
  const missedInsertPath = '../src/services/missedWindowInsert';
  try { missedInsert = await import(missedInsertPath); } catch { missedInsert = null; }

  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `u2u5-${Date.now().toString(36)}`;
  let companyId = '';

  try {
    const t0 = ms((await q(`SELECT date_trunc('second', NOW()) AS t0`)).rows[0].t0);
    const at = (m: number): Date => new Date(t0 + m * MIN);

    // ── fixtures ────────────────────────────────────────────────────────────
    companyId = (await q(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [marker])).rows[0].id;
    const otherCompanyId = (await q(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`${marker}-other`])).rows[0].id;
    const siteName = `${marker} site`;
    const siteId = (await q(
      `INSERT INTO sites (company_id, name, address, timezone, contract_start)
       VALUES ($1, $2, 'addr', $3, CURRENT_DATE - 30) RETURNING id`, [companyId, siteName, TZ])).rows[0].id;
    const adminId = (await q(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const admin = { sub: adminId, role: 'company_admin', company_id: companyId };
    actor = admin;

    let gN = 0;
    const tokenOf = new Map<string, string>();
    async function mkGuard(): Promise<string> {
      gN += 1;
      const id = (await q(
        `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
         VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
        [companyId, `${marker} g${gN}`, `${marker}-g${gN}@test.invalid`, `U2T${gN}`])).rows[0].id;
      const token = `ExponentPushToken[${marker}-g${gN}]`;
      await q(`INSERT INTO guard_devices (guard_id, push_token, last_seen_at) VALUES ($1, $2, NOW())`, [id, token]);
      await q(`INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) VALUES ($1, $2, CURRENT_DATE - 30)`, [id, siteId]);
      tokenOf.set(id, token);
      return id;
    }
    const EXPIRES = at(60 * 24 * 1500);
    async function mkShift(guardId: string | null, s: number, e: number, status: string): Promise<string> {
      return (await q(
        `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, source, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6) RETURNING id`,
        [guardId, siteId, at(s), at(e), status, EXPIRES])).rows[0].id;
    }
    async function mkSession(shiftId: string, guardId: string, inM: number, outM: number | null = null): Promise<string> {
      return (await q(
        `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords)
         VALUES ($1, $2, $3, $4, $5, '(0,0)') RETURNING id`,
        [shiftId, guardId, siteId, at(inM), outM === null ? null : at(outM)])).rows[0].id;
    }
    const shiftRow = async (id: string) => (await q(`SELECT * FROM shifts WHERE id = $1`, [id])).rows[0];
    const sessRow  = async (id: string) => (await q(`SELECT * FROM shift_sessions WHERE id = $1`, [id])).rows[0];
    const auditRows = async (id: string) =>
      (await q(`SELECT * FROM shift_schedule_audit WHERE shift_id = $1 ORDER BY changed_at`, [id])).rows;
    async function lastNotif(guardId: string, type = 'shift_schedule_edited'): Promise<any> {
      for (let i = 0; i < 40; i += 1) {
        const r = await q(`SELECT title, body, data FROM notifications WHERE guard_id = $1 AND type = $2
                           ORDER BY created_at DESC LIMIT 1`, [guardId, type]);
        if (r.rows[0]) return r.rows[0];
        await sleep(50);
      }
      return null;
    }
    const pushFor = (guardId: string) => pushes.filter((p) => p.token === tokenOf.get(guardId));
    const patch = (id: string, body: Record<string, unknown>) => callRoute(router, 'patch', '/:id', { params: { id }, body });

    // ════════════════════════════════════════════════════════════════════════
    section('E1 extend an active shift: end moves, reminder latch cleared, audit, push');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -120, 60, 'active');
      const ss = await mkSession(sh, g, -125);
      await q(`UPDATE shift_sessions SET clock_out_reminder_sent_at = $2 WHERE id = $1`, [ss, at(-2)]);
      const r = await patch(sh, { scheduled_end: at(180).toISOString(), reason: 'relief late' });
      check(r.status === 200, `200 (got ${r.status} ${show(r.body)})`);
      check(r.body?.active_end_edit?.outcome === 'extended', `outcome 'extended' (got ${show(r.body?.active_end_edit)})`);
      const s = await shiftRow(sh);
      check(ms(s.scheduled_end) === at(180).getTime(), 'scheduled_end = t0+180');
      check(ms(s.scheduled_start) === at(-120).getTime(), 'scheduled_start unchanged');
      check(s.status === 'active', `status stays active (got ${s.status})`);
      check(ms(s.expires_at) === EXPIRES.getTime(), 'expires_at unchanged (start-anchored)');
      const se = await sessRow(ss);
      check(se.clocked_out_at === null, 'session still open');
      check(se.clock_out_reminder_sent_at === null, 'clock_out_reminder_sent_at reset to NULL');
      const a = await auditRows(sh);
      check(a.length === 1 && a[0].action === 'shift_schedule_edited' && a[0].changed_by === adminId
            && a[0].changed_by_role === 'company_admin' && a[0].reason === 'relief late',
            `one audit row, action/actor/reason (got ${a.length})`);
      check(a.length === 1 && ms(a[0].before.scheduled_end) === at(60).getTime()
            && ms(a[0].after.scheduled_end) === at(180).getTime()
            && ms(a[0].before.scheduled_start) === at(-120).getTime()
            && ms(a[0].after.scheduled_start) === at(-120).getTime(),
            'audit before/after carry both keys, start equal, end old -> new');
      const n = await lastNotif(g);
      const expTitle = `Shift extended at ${siteName}`;
      const expBody  = `Your shift now ends ${dayLabel(at(180))}, ${timeLabel(at(180))}. Fully close and reopen NetraOps to update your screen.`;
      check(n?.title === expTitle, `notification title "${expTitle}" (got "${n?.title}")`);
      check(n?.body === expBody, `notification body "${expBody}" (got "${n?.body}")`);
      await sleep(100);
      const p = pushFor(g).at(-1);
      check(p?.title === expTitle && p?.body === expBody, 'push carries the same title and body');
      check(p?.data?.type === 'shift_schedule_edited' && ms(p?.data?.scheduled_end) === at(180).getTime(),
            `push data type + new end (got ${show(p?.data)})`);
    }

    section('E2 extend into the guard\'s next shift -> 409 with the conflict, nothing written');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -120, 60, 'active');
      await mkSession(sh, g, -120);
      const next = await mkShift(g, 120, 360, 'scheduled');
      const r = await patch(sh, { scheduled_end: at(150).toISOString() });
      check(r.status === 409 && r.body?.conflict?.shift_id === next, `409 conflict names the next shift (got ${r.status} ${show(r.body)})`);
      check(ms((await shiftRow(sh)).scheduled_end) === at(60).getTime(), 'end unchanged');
      check((await auditRows(sh)).length === 0, 'no audit row');
      const back = await patch(sh, { scheduled_end: at(120).toISOString() });
      check(back.status === 200, `back-to-back (new end = next start) allowed, half-open (got ${back.status} ${show(back.body)})`);
    }

    section('E3 extend past 12 h -> 409 LONG_SHIFT_CONFIRM_REQUIRED; with the flag -> 200');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -600, 60, 'active');
      await mkSession(sh, g, -600);
      const r = await patch(sh, { scheduled_end: at(180).toISOString() });
      check(r.status === 409 && r.body?.code === 'LONG_SHIFT_CONFIRM_REQUIRED', `409 LONG_SHIFT_CONFIRM_REQUIRED (got ${r.status} ${show(r.body)})`);
      check(r.body?.duration_minutes === 780, `duration_minutes 780 (got ${r.body?.duration_minutes})`);
      check(r.body?.ends_at_label === `Ends ${endsLabel(at(180))} — 13h`, `ends_at_label (got "${r.body?.ends_at_label}")`);
      check(r.body?.confirm_with?.confirm_long_shift === true, 'confirm_with.confirm_long_shift');
      check(ms((await shiftRow(sh)).scheduled_end) === at(60).getTime(), 'end unchanged after the 409');
      const ok = await patch(sh, { scheduled_end: at(180).toISOString(), confirm_long_shift: true });
      check(ok.status === 200 && ok.body?.active_end_edit?.outcome === 'extended', `200 with the flag (got ${ok.status})`);
      const bad = await patch(sh, { scheduled_end: at(200).toISOString(), confirm_long_shift: 'yes' });
      check(bad.status === 400, `non-boolean flag -> 400 (got ${bad.status})`);
    }

    section('S1 shorten to a later-than-now end: stays open, latch cleared, "Clock out at that time."');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -120, 240, 'active');
      const ss = await mkSession(sh, g, -120);
      await q(`UPDATE shift_sessions SET clock_out_reminder_sent_at = $2 WHERE id = $1`, [ss, at(-1)]);
      const r = await patch(sh, { scheduled_end: at(60).toISOString() });
      check(r.status === 200 && r.body?.active_end_edit?.outcome === 'shortened', `200 shortened (got ${r.status} ${show(r.body)})`);
      check(ms((await shiftRow(sh)).scheduled_end) === at(60).getTime(), 'scheduled_end = t0+60');
      const se = await sessRow(ss);
      check(se.clocked_out_at === null && se.clock_out_reminder_sent_at === null, 'open, latch cleared');
      const n = await lastNotif(g);
      check(n?.title === `Shift end changed at ${siteName}`, `title (got "${n?.title}")`);
      check(n?.body === `Your shift now ends ${dayLabel(at(60))}, ${timeLabel(at(60))}. Clock out at that time.`, `body (got "${n?.body}")`);
    }

    // ════════════════════════════════════════════════════════════════════════
    section('C1 close in the past: session, breaks, violations, missed rows, shift, audit, push, handoff');
    let c1Shift = ''; let c1Sess = '';
    {
      // Window [-480, +120]; clock-in 5 min early; the admin sets the end to -90.
      const g = await mkGuard();
      const other = await mkGuard();
      const sh = await mkShift(g, -480, 120, 'active');
      const ss = await mkSession(sh, g, -485);
      c1Shift = sh; c1Sess = ss;
      const E = at(-90);
      // breaks: one closed by the guard long before E (untouched), one open from -100 (closed at E)
      const bClosed = (await q(`INSERT INTO break_sessions (shift_session_id, guard_id, site_id, break_start, break_end, duration_minutes, break_type, planned_duration_minutes, ended_by)
                                VALUES ($1,$2,$3,$4,$5,30,'break',30,'guard') RETURNING id`, [ss, g, siteId, at(-200), at(-170)])).rows[0].id;
      const bOpen = (await q(`INSERT INTO break_sessions (shift_session_id, guard_id, site_id, break_start, break_type, planned_duration_minutes)
                              VALUES ($1,$2,$3,$4,'break',30) RETURNING id`, [ss, g, siteId, at(-100)])).rows[0].id;
      // violations: V1 open from -150; V2 born -40 and resolved -30 (both after E); V3 resolved before E
      const v = async (occ: number, res: number | null, dur: number | null) => (await q(
        `INSERT INTO geofence_violations (shift_session_id, guard_id, site_id, violation_lat, violation_lng, occurred_at, resolved_at, duration_minutes, position_source)
         VALUES ($1,$2,$3,0,0,$4,$5,$6,'site') RETURNING id`, [ss, g, siteId, at(occ), res === null ? null : at(res), dur])).rows[0].id;
      const v1 = await v(-150, null, null);
      const v2 = await v(-40, -30, 10);
      const v3 = await v(-210, -200, 10);
      // missed rows: windows ending before, AT, and after E; one after E already resolved (answered late)
      const mp = async (ws: number, we: number, resolved: boolean) => (await q(
        `INSERT INTO missed_pings (shift_session_id, site_id, guard_id, window_start, window_end, window_label, resolved_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,'x',$6,$7) RETURNING id`, [ss, siteId, g, at(ws), at(we), resolved ? at(we + 5) : null, EXPIRES])).rows[0].id;
      const keepA = await mp(-180, -150, false);
      const keepB = await mp(-120, -90, false);   // window_end = E exactly: kept
      const dropC = await mp(-90, -60, false);
      const dropD = await mp(-60, -30, true);     // resolved, still after E: deleted
      const mr = async (ws: number, we: number) => (await q(
        `INSERT INTO missed_reports (shift_session_id, site_id, guard_id, window_start, window_end, window_label, expires_at)
         VALUES ($1,$2,$3,$4,$5,'x',$6) RETURNING id`, [ss, siteId, g, at(ws), at(we), EXPIRES])).rows[0].id;
      const keepR = await mr(-180, -120);
      const dropR = await mr(-120, -60);
      // an open handoff on the shift (pending, nobody arrived)
      const ho = (await q(`INSERT INTO shift_swap_requests (shift_id, from_guard_id, to_guard_id, initiated_by, status)
                           VALUES ($1,$2,$3,'guard_handoff','pending') RETURNING id`, [sh, g, other])).rows[0].id;

      const noConfirm = await patch(sh, { scheduled_end: E.toISOString() });
      check(noConfirm.status === 409 && noConfirm.body?.code === 'CLOSE_CONFIRM_REQUIRED'
            && ms(noConfirm.body?.clocks_out_at) === E.getTime(),
            `without confirm_close_session -> 409 CLOSE_CONFIRM_REQUIRED at E (got ${noConfirm.status} ${show(noConfirm.body)})`);
      check((await sessRow(ss)).clocked_out_at === null, '...and nothing was written');

      const r = await patch(sh, { scheduled_end: E.toISOString(), confirm_close_session: true, reason: 'left at 18:00' });
      check(r.status === 200 && r.body?.active_end_edit?.outcome === 'closed', `200 closed (got ${r.status} ${show(r.body)})`);
      const exp = { hours: (-90 - -480) / 60 };   // clock-in -485 is clamped to the start -480: 390 min = 6.5 h
      const se = await sessRow(ss);
      check(ms(se.clocked_out_at) === E.getTime(), 'session clocked_out_at = E');
      check(se.clock_out_reason === 'admin_corrected', `clock_out_reason 'admin_corrected' (got ${se.clock_out_reason})`);
      check(near(Number(se.total_hours), exp.hours), `total_hours ${exp.hours} (got ${se.total_hours})`);
      check(se.clock_out_lat === null && se.clock_out_photo_url === null, 'no clock-out coordinates or photo');
      const bo = (await q(`SELECT * FROM break_sessions WHERE id = $1`, [bOpen])).rows[0];
      check(ms(bo.break_end) === E.getTime() && bo.duration_minutes === 10 && bo.ended_by === 'auto_complete',
            `open break (-100) closed at E, 10 min, 'auto_complete' (got ${show([bo.break_end, bo.duration_minutes, bo.ended_by])})`);
      const bc = (await q(`SELECT * FROM break_sessions WHERE id = $1`, [bClosed])).rows[0];
      check(ms(bc.break_end) === at(-170).getTime() && bc.ended_by === 'guard' && bc.duration_minutes === 30, 'closed break untouched');
      const vr = async (id: string) => (await q(`SELECT resolved_at, duration_minutes FROM geofence_violations WHERE id = $1`, [id])).rows[0];
      const V1 = await vr(v1); const V2 = await vr(v2); const V3 = await vr(v3);
      check(ms(V1.resolved_at) === E.getTime() && V1.duration_minutes === 60, `V1 open from -150 -> resolved at E, 60 min (got ${show(V1)})`);
      check(ms(V2.resolved_at) === at(-40).getTime() && V2.duration_minutes === 0, `V2 born after E -> resolved at its birth, 0 min (got ${show(V2)})`);
      check(ms(V3.resolved_at) === at(-200).getTime() && V3.duration_minutes === 10, `V3 resolved before E -> untouched (got ${show(V3)})`);
      const mpLeft = (await q(`SELECT id FROM missed_pings WHERE shift_session_id = $1 ORDER BY window_start`, [ss])).rows.map((x: any) => x.id);
      check(show(mpLeft) === show([keepA, keepB]), 'missed_pings: the two ending at or before E stay; the two after E (one resolved) are gone');
      const mrLeft = (await q(`SELECT id FROM missed_reports WHERE shift_session_id = $1`, [ss])).rows.map((x: any) => x.id);
      check(show(mrLeft) === show([keepR]), 'missed_reports: the one after E is gone');
      void dropC; void dropD; void dropR;
      const ae = r.body?.active_end_edit ?? {};
      check(ae.breaks_closed === 1 && ae.violations_resolved === 2 && ae.missed_pings_deleted === 2 && ae.missed_reports_deleted === 1,
            `response counts 1 break, 2 violations, 2 + 1 missed (got ${show(ae)})`);
      const s = await shiftRow(sh);
      check(s.status === 'completed' && ms(s.scheduled_end) === E.getTime(), `shift completed, scheduled_end = E (got ${s.status})`);
      check(ms(s.expires_at) === EXPIRES.getTime(), 'shift expires_at unchanged');
      const a = await auditRows(sh);
      check(a.length === 1 && ms(a[0].before.scheduled_end) === at(120).getTime() && ms(a[0].after.scheduled_end) === E.getTime()
            && a[0].reason === 'left at 18:00', 'one audit row, end +120 -> E, reason kept');
      const n = await lastNotif(g);
      check(n?.title === `Shift ended at ${siteName}`, `title (got "${n?.title}")`);
      check(n?.body === `Your admin ended this shift at ${timeLabel(E)}. You are now clocked out.`, `body (got "${n?.body}")`);
      let hs: any = null;
      for (let i = 0; i < 40 && !(hs && hs.status === 'cancelled'); i += 1) {
        hs = (await q(`SELECT status, declined_at FROM shift_swap_requests WHERE id = $1`, [ho])).rows[0];
        if (hs.status !== 'cancelled') await sleep(50);
      }
      check(hs?.status === 'cancelled' && hs?.declined_at !== null, `open handoff cancelled after commit (got ${show(hs)})`);
      const hA = await lastNotif(g, 'handoff_cancelled');
      const hB = await lastNotif(other, 'handoff_cancelled');
      check(hA?.body === `Your admin cancelled the handoff for ${siteName}.` && hB?.body === hA?.body,
            `both guards told the handoff was cancelled (got "${hA?.body}" / "${hB?.body}")`);
      const again = await patch(sh, { scheduled_end: at(-60).toISOString(), confirm_close_session: true });
      check(again.status === 409, `a completed shift is no longer editable (got ${again.status})`);
    }

    section('C2 close with the open break starting AFTER the new end -> zero-length at its own start');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -240, 60, 'active');
      const ss = await mkSession(sh, g, -240);
      const b = (await q(`INSERT INTO break_sessions (shift_session_id, guard_id, site_id, break_start, break_type, planned_duration_minutes)
                          VALUES ($1,$2,$3,$4,'break',30) RETURNING id`, [ss, g, siteId, at(-20)])).rows[0].id;
      const r = await patch(sh, { scheduled_end: at(-30).toISOString(), confirm_close_session: true });
      check(r.status === 200, `200 (got ${r.status} ${show(r.body)})`);
      const br = (await q(`SELECT break_end, duration_minutes FROM break_sessions WHERE id = $1`, [b])).rows[0];
      check(ms(br.break_end) === at(-20).getTime() && br.duration_minutes === 0, `break_end = its start, 0 min (got ${show(br)})`);
      check(near(Number((await sessRow(ss)).total_hours), 210 / 60), 'total_hours 3.5');
    }

    section('C3 legal hold -> 409 LEGAL_HOLD on close; extend still allowed');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -240, 60, 'active');
      const ss = await mkSession(sh, g, -240);
      await q(`UPDATE shift_sessions SET legal_hold = true, legal_hold_at = NOW() WHERE id = $1`, [ss]);
      const r = await patch(sh, { scheduled_end: at(-30).toISOString(), confirm_close_session: true });
      check(r.status === 409 && r.body?.code === 'LEGAL_HOLD', `409 LEGAL_HOLD (got ${r.status} ${show(r.body)})`);
      check((await sessRow(ss)).clocked_out_at === null, 'session still open');
      const ext = await patch(sh, { scheduled_end: at(90).toISOString() });
      check(ext.status === 200, `extend on a held shift -> 200 (got ${ext.status})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    section('G grace timing (decision 7a): keep-open edits stop a minute before the auto clock-out');
    {
      // G1: ended -14 -> auto clock-out due at +1 -> inside the 60 s margin: extend refused, close allowed.
      const g1 = await mkGuard();
      const sh1 = await mkShift(g1, -240, -14, 'active');
      const ss1 = await mkSession(sh1, g1, -240);
      const ext = await patch(sh1, { scheduled_end: at(60).toISOString() });
      check(ext.status === 409 && ext.body?.code === 'SHIFT_AUTO_CLOSING', `extend at end+14 -> 409 SHIFT_AUTO_CLOSING (got ${ext.status} ${show(ext.body)})`);
      check(ms((await shiftRow(sh1)).scheduled_end) === at(-14).getTime(), '...end unchanged');
      const cls = await patch(sh1, { scheduled_end: at(-30).toISOString(), confirm_close_session: true });
      check(cls.status === 200 && ms((await sessRow(ss1)).clocked_out_at) === at(-30).getTime(),
            `close in the past at end+14 -> 200 (got ${cls.status} ${show(cls.body)})`);
      // G2: ended -10 -> auto clock-out at +5 -> 4 minutes of margin: extending inside the grace works.
      const g2 = await mkGuard();
      const sh2 = await mkShift(g2, -240, -10, 'active');
      await mkSession(sh2, g2, -240);
      const ext2 = await patch(sh2, { scheduled_end: at(60).toISOString() });
      check(ext2.status === 200 && ext2.body?.active_end_edit?.outcome === 'extended',
            `extend inside the grace with margin left -> 200 (got ${ext2.status} ${show(ext2.body)})`);
    }

    section('R refusals and gates');
    {
      // R1 new end at/before the clock-in
      const g1 = await mkGuard();
      const sh1 = await mkShift(g1, -120, 60, 'active');
      await mkSession(sh1, g1, -60);
      const r1 = await patch(sh1, { scheduled_end: at(-70).toISOString(), confirm_close_session: true });
      check(r1.status === 422 && r1.body?.code === 'END_BEFORE_CLOCK_IN', `end before clock-in -> 422 END_BEFORE_CLOCK_IN (got ${r1.status} ${show(r1.body)})`);
      // R2 guard clocked in early; new end after the clock-in but before the start
      const g2 = await mkGuard();
      const sh2 = await mkShift(g2, 20, 200, 'active');
      await mkSession(sh2, g2, -10);
      const r2 = await patch(sh2, { scheduled_end: at(10).toISOString() });
      check(r2.status === 422 && r2.body?.code === 'END_NOT_AFTER_START', `end before scheduled_start -> 422 END_NOT_AFTER_START (got ${r2.status} ${show(r2.body)})`);
      // R3 a different start is refused; the stored start is accepted
      const r3 = await patch(sh1, { scheduled_start: at(-100).toISOString(), scheduled_end: at(90).toISOString() });
      check(r3.status === 422 && r3.body?.code === 'START_LOCKED', `start sent and different -> 422 START_LOCKED (got ${r3.status} ${show(r3.body)})`);
      const r3b = await patch(sh1, { scheduled_start: at(-120).toISOString(), scheduled_end: at(90).toISOString() });
      check(r3b.status === 200, `start sent and equal -> 200 (got ${r3b.status} ${show(r3b.body)})`);
      // R4 no open session
      const g4 = await mkGuard();
      const sh4 = await mkShift(g4, -120, 60, 'active');
      await mkSession(sh4, g4, -120, -60);
      const r4 = await patch(sh4, { scheduled_end: at(90).toISOString() });
      check(r4.status === 409 && r4.body?.code === 'NO_OPEN_SESSION', `active with no open session -> 409 NO_OPEN_SESSION (got ${r4.status} ${show(r4.body)})`);
      // R5 the open session is another guard's (the reassign anomaly)
      const g5a = await mkGuard(); const g5b = await mkGuard();
      const sh5 = await mkShift(g5a, -120, 60, 'active');
      await mkSession(sh5, g5b, -120);
      const r5 = await patch(sh5, { scheduled_end: at(-30).toISOString(), confirm_close_session: true });
      check(r5.status === 409 && r5.body?.code === 'SESSION_STATE_CONFLICT', `session guard != shift guard -> 409 SESSION_STATE_CONFLICT (got ${r5.status} ${show(r5.body)})`);
      // R6 two open sessions
      const g6a = await mkGuard(); const g6b = await mkGuard();
      const sh6 = await mkShift(g6a, -120, 60, 'active');
      await mkSession(sh6, g6a, -120); await mkSession(sh6, g6b, -100);
      const r6 = await patch(sh6, { scheduled_end: at(90).toISOString() });
      check(r6.status === 409 && r6.body?.code === 'SESSION_STATE_CONFLICT', `two open sessions -> 409 SESSION_STATE_CONFLICT (got ${r6.status} ${show(r6.body)})`);
      // R7 no-op
      const g7 = await mkGuard();
      const sh7 = await mkShift(g7, -120, 60, 'active');
      await mkSession(sh7, g7, -120);
      const r7 = await patch(sh7, { scheduled_end: at(60).toISOString() });
      check(r7.status === 200 && (await auditRows(sh7)).length === 0, `same end -> 200, no audit row (got ${r7.status})`);
      // R8 another company's admin
      actor = { sub: adminId, role: 'company_admin', company_id: otherCompanyId };
      const r8 = await patch(sh7, { scheduled_end: at(90).toISOString() });
      check(r8.status === 404, `other company's admin -> 404 (got ${r8.status})`);
      actor = admin;
      // R9 the UNCHANGED end, already passed (inside the grace): that is a close at the stored end, not a no-op
      const g9 = await mkGuard();
      const sh9 = await mkShift(g9, -240, -5, 'active');
      const ss9 = await mkSession(sh9, g9, -240);
      const r9 = await patch(sh9, { scheduled_end: at(-5).toISOString() });
      check(r9.status === 409 && r9.body?.code === 'CLOSE_CONFIRM_REQUIRED',
            `same end, already passed, no flag -> 409 CLOSE_CONFIRM_REQUIRED (got ${r9.status} ${show(r9.body)})`);
      const r9b = await patch(sh9, { scheduled_end: at(-5).toISOString(), confirm_close_session: true });
      const s9 = await sessRow(ss9);
      check(r9b.status === 200 && r9b.body?.active_end_edit?.outcome === 'closed'
            && ms(s9.clocked_out_at) === at(-5).getTime() && s9.clock_out_reason === 'admin_corrected'
            && (await auditRows(sh9)).length === 1,
            `...with the flag -> closed at the stored end, 'admin_corrected', audited (got ${r9b.status} ${show(r9b.body?.active_end_edit)})`);
      // R10 a confirmed close whose end has not arrived by the database's clock
      const g10 = await mkGuard();
      const sh10 = await mkShift(g10, -240, 120, 'active');
      await mkSession(sh10, g10, -240);
      const r10 = await patch(sh10, { scheduled_end: at(2).toISOString(), confirm_close_session: true });
      check(r10.status === 409 && r10.body?.code === 'CLOSE_END_NOT_PAST' && ms((await shiftRow(sh10)).scheduled_end) === at(120).getTime(),
            `confirmed close with a future end -> 409 CLOSE_END_NOT_PAST, end unchanged (got ${r10.status} ${show(r10.body)})`);
      // R11 order: an extension that overlaps AND runs past 12 h answers the overlap, not the confirm
      const g11 = await mkGuard();
      const sh11 = await mkShift(g11, -600, 60, 'active');
      await mkSession(sh11, g11, -600);
      const nx11 = await mkShift(g11, 120, 300, 'scheduled');
      const r11 = await patch(sh11, { scheduled_end: at(150).toISOString() });
      check(r11.status === 409 && r11.body?.conflict?.shift_id === nx11,
            `overlap + over 12 h -> the overlap 409, not the confirm (got ${r11.status} ${show(r11.body?.code ?? r11.body?.conflict)})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    section('L locks: the admin yields; guard traffic does not block it');
    {
      const other = new Client(); await other.connect();
      try {
        // L1 a writer holds the session row (the guard's clock-out takes this lock first) -> SHIFT_BUSY within ~0.5 s
        const g1 = await mkGuard();
        const sh1 = await mkShift(g1, -120, 60, 'active');
        const ss1 = await mkSession(sh1, g1, -120);
        await other.query('BEGIN');
        await other.query(`UPDATE shift_sessions SET clock_out_reminder_sent_at = NOW() WHERE id = $1`, [ss1]);
        const t = Date.now();
        const r1 = await patch(sh1, { scheduled_end: at(90).toISOString() });
        const took = Date.now() - t;
        check(r1.status === 409 && r1.body?.code === 'SHIFT_BUSY', `session row held -> 409 SHIFT_BUSY (got ${r1.status} ${show(r1.body)})`);
        check(took < 2500, `...after the 500 ms child-lock timeout, not the 3 s shift one (${took} ms)`);
        await other.query('ROLLBACK');
        check(ms((await shiftRow(sh1)).scheduled_end) === at(60).getTime(), '...and nothing was written');

        // L2 a KEY SHARE lock on the session (what every ping/report/break INSERT takes) does not block the edit
        await other.query('BEGIN');
        await other.query(`SELECT 1 FROM shift_sessions WHERE id = $1 FOR KEY SHARE`, [ss1]);
        const t2 = Date.now();
        const r2 = await patch(sh1, { scheduled_end: at(90).toISOString() });
        check(r2.status === 200 && Date.now() - t2 < 400, `KEY SHARE held -> 200 without waiting (got ${r2.status}, ${Date.now() - t2} ms)`);
        await other.query('ROLLBACK');

        // L3 the manual clock-out order (session, then shift) against the close (shift, then session):
        //    the admin times out first and rolls back; the guard's transaction completes with no deadlock error.
        const g3 = await mkGuard();
        const sh3 = await mkShift(g3, -120, 60, 'active');
        const ss3 = await mkSession(sh3, g3, -120);
        await other.query('BEGIN');
        await other.query(`UPDATE shift_sessions SET clocked_out_at = NOW(), clock_out_reason = 'manual' WHERE id = $1`, [ss3]);
        const patching = patch(sh3, { scheduled_end: at(-30).toISOString(), confirm_close_session: true });
        await sleep(150);
        let guardErr: unknown = null;
        const guardShift = other.query(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [sh3]).catch((e) => { guardErr = e; });
        const r3 = await patching;
        await guardShift;
        await other.query(guardErr ? 'ROLLBACK' : 'COMMIT');
        check(r3.status === 409 && r3.body?.code === 'SHIFT_BUSY', `admin close vs a clock-out in flight -> admin gets 409 SHIFT_BUSY (got ${r3.status} ${show(r3.body)})`);
        check(guardErr === null, `the guard's clock-out transaction committed, no deadlock error (${guardErr ? String((guardErr as any).code) : 'none'})`);
        const s3 = await sessRow(ss3);
        check(s3.clock_out_reason === 'manual' && (await shiftRow(sh3)).status === 'completed' && (await auditRows(sh3)).length === 0,
              'the guard\'s clock-out stands; no admin write, no audit row');
      } finally {
        await other.end();
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    section('U5 create paths (POST /api/shifts) and the scheduled edit');
    {
      const post = (body: Record<string, unknown>) => callRoute(router, 'post', '/', { body });
      const day = (n: number) => {
        const d = new Date(t0 + n * 86_400_000);
        return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ }).format(d);
      };
      // Build an instant for a site-local wall clock via the database (DST-correct), independent of the route.
      const local = async (date: string, time: string, plusDays = 0) =>
        new Date((await q(`SELECT (($1::date + $3::int) + $2::time) AT TIME ZONE $4 AS t`, [date, time, plusDays, TZ])).rows[0].t);
      const d3 = day(3);
      const s0800 = await local(d3, '08:00');
      const e0200 = await local(d3, '02:00', 1);
      const r18 = await post({ site_id: siteId, scheduled_start: s0800.toISOString(), scheduled_end: e0200.toISOString() });
      check(r18.status === 409 && r18.body?.code === 'LONG_SHIFT_CONFIRM_REQUIRED' && r18.body?.duration_minutes === 1080,
            `single 18 h -> 409, 1080 min (got ${r18.status} ${show(r18.body)})`);
      check(r18.body?.ends_at_label === `Ends ${endsLabel(e0200)} — 18h`, `label "Ends ${endsLabel(e0200)} — 18h" (got "${r18.body?.ends_at_label}")`);
      const r18ok = await post({ site_id: siteId, scheduled_start: s0800.toISOString(), scheduled_end: e0200.toISOString(), confirm_long_shift: true });
      check(r18ok.status === 201, `single 18 h with the flag -> 201 (got ${r18ok.status})`);
      const e2000 = await local(d3, '20:00');
      const r12 = await post({ site_id: siteId, scheduled_start: s0800.toISOString(), scheduled_end: e2000.toISOString() });
      check(r12.status === 201, `single exactly 12 h -> 201, no confirm (got ${r12.status} ${show(r12.body)})`);
      const r1201 = await post({ site_id: siteId, scheduled_start: s0800.toISOString(), scheduled_end: new Date(e2000.getTime() + MIN).toISOString() });
      check(r1201.status === 409, `single 12 h 01 m -> 409 (got ${r1201.status})`);
      const rInv = await post({ site_id: siteId, scheduled_start: e2000.toISOString(), scheduled_end: s0800.toISOString() });
      check(rInv.status === 422 && rInv.body?.code === 'END_NOT_AFTER_START', `single inverted -> 422 (got ${rInv.status} ${show(rInv.body)})`);
      const rZero = await post({ site_id: siteId, scheduled_start: s0800.toISOString(), scheduled_end: s0800.toISOString() });
      check(rZero.status === 422 && rZero.body?.code === 'END_NOT_AFTER_START', `single zero-length -> 422 (got ${rZero.status})`);
      const rBad = await post({ site_id: siteId, scheduled_start: 'not-a-date', scheduled_end: s0800.toISOString() });
      check(rBad.status === 400, `single invalid date -> 400 (got ${rBad.status})`);
      const ga = await mkGuard();
      const rInvG = await post({ site_id: siteId, guard_id: ga, scheduled_start: e2000.toISOString(), scheduled_end: s0800.toISOString() });
      check(rInvG.status === 422 && rInvG.body?.code === 'END_NOT_AFTER_START',
            `single inverted WITH a guard -> 422, not a 500 (got ${rInvG.status}${rInvG.threw ? ' threw ' + String((rInvG.threw as any)?.code) : ''})`);

      const d5 = day(5);
      const rs = await local(d5, '19:00'); const re = await local(d5, '08:00', 1);
      const rep = await post({ site_id: siteId, scheduled_start: rs.toISOString(), scheduled_end: re.toISOString(), repeat_days: [1, 3] });
      check(rep.status === 409 && rep.body?.code === 'LONG_SHIFT_CONFIRM_REQUIRED', `repeat 13 h -> 409 (got ${rep.status} ${show(rep.body)})`);
      const repOk = await post({ site_id: siteId, scheduled_start: rs.toISOString(), scheduled_end: re.toISOString(), repeat_days: [1, 3], confirm_long_shift: true });
      check(repOk.status === 201 && Array.isArray(repOk.body) && repOk.body.length > 0, `repeat 13 h with the flag -> 201 (got ${repOk.status})`);
      const repInv = await post({ site_id: siteId, scheduled_start: re.toISOString(), scheduled_end: rs.toISOString(), repeat_days: [1, 3] });
      check(repInv.status === 422 && repInv.body?.code === 'END_NOT_AFTER_START', `repeat inverted -> 422, no series (got ${repInv.status})`);

      const sd = (body: Record<string, unknown>) => post({ mode: 'specific_dates', site_id: siteId, ...body });
      const d7 = day(7);
      const sEq = await sd({ start_time: '09:00', end_time: '09:00', dates: [d7] });
      check(sEq.status === 422 && sEq.body?.code === 'END_NOT_AFTER_START', `specific_dates start = end -> 422 (got ${sEq.status} ${show(sEq.body)})`);
      const s13 = await sd({ start_time: '19:00', end_time: '08:00', dates: [d7] });
      check(s13.status === 409 && s13.body?.duration_minutes === 780, `specific_dates 19:00 -> 08:00 (13 h) -> 409 (got ${s13.status} ${show(s13.body)})`);
      const s13ok = await sd({ start_time: '19:00', end_time: '08:00', dates: [d7], confirm_long_shift: true });
      check(s13ok.status === 201, `...with the flag -> 201 (got ${s13ok.status})`);
      // Elapsed, not wall clock: 19:00 -> 07:00 is 12 h on 2026-10-30 but 13 h across the 2026-11-01 fall-back.
      const s12 = await sd({ start_time: '19:00', end_time: '07:00', dates: ['2026-10-30'] });
      check(s12.status === 201, `19:00 -> 07:00 on 2026-10-30 (12 h) -> 201 (got ${s12.status} ${show(s12.body)})`);
      const sDst = await sd({ start_time: '19:00', end_time: '07:00', dates: ['2026-10-31'] });
      check(sDst.status === 409 && sDst.body?.duration_minutes === 780,
            `19:00 -> 07:00 on 2026-10-31 (13 h elapsed across the fall-back) -> 409 (got ${sDst.status} ${show(sDst.body)})`);

      // the scheduled edit: unchanged behaviour + the 12 h rule + the end > start code
      const gs = await mkGuard();
      const sch = await mkShift(gs, 60 * 24, 60 * 24 + 480, 'scheduled');
      await q(`UPDATE shifts SET pre_shift_reminder_sent_at = NOW() WHERE id = $1`, [sch]);
      const eOk = await patch(sch, { scheduled_start: at(60 * 24 + 60).toISOString(), scheduled_end: at(60 * 24 + 540).toISOString() });
      check(eOk.status === 200, `scheduled edit start+end -> 200 (got ${eOk.status} ${show(eOk.body)})`);
      const schRow = await shiftRow(sch);
      check(schRow.pre_shift_reminder_sent_at === null && ms(schRow.scheduled_start) === at(60 * 24 + 60).getTime(),
            'scheduled edit re-arms the latches and moves the start (unchanged)');
      const ns = await lastNotif(gs);
      check(ns?.title === `Shift time changed at ${siteName}`, `scheduled edit push title unchanged (got "${ns?.title}")`);
      const eLong = await patch(sch, { scheduled_start: at(60 * 24 + 60).toISOString(), scheduled_end: at(60 * 24 + 60 + 780).toISOString() });
      check(eLong.status === 409 && eLong.body?.code === 'LONG_SHIFT_CONFIRM_REQUIRED', `scheduled edit to 13 h -> 409 (got ${eLong.status})`);
      const eLongOk = await patch(sch, { scheduled_start: at(60 * 24 + 60).toISOString(), scheduled_end: at(60 * 24 + 60 + 780).toISOString(), confirm_long_shift: true });
      check(eLongOk.status === 200, `...with the flag -> 200 (got ${eLongOk.status})`);
      const eInv = await patch(sch, { scheduled_start: at(60 * 24 + 60).toISOString(), scheduled_end: at(60 * 24).toISOString() });
      check(eInv.status === 422 && eInv.body?.code === 'END_NOT_AFTER_START', `scheduled edit inverted -> 422 with code (got ${eInv.status} ${show(eInv.body)})`);
      const eNoStart = await patch(sch, { scheduled_end: at(60 * 24 + 600).toISOString() });
      check(eNoStart.status === 400, `scheduled edit without a start -> 400, as before (got ${eNoStart.status})`);
    }

    section('GET /api/shifts/:id open-session fields');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -60, 60, 'active');
      await mkSession(sh, g, -61);
      const r = await callRoute(router, 'get', '/:id', { params: { id: sh } });
      check(r.body?.open_session_count === 1 && ms(r.body?.open_session_clocked_in_at) === at(-61).getTime() && r.body?.has_session === true,
            `active: open_session_count 1, clock-in, has_session (got ${show([r.body?.open_session_count, r.body?.open_session_clocked_in_at, r.body?.has_session])})`);
      const r2 = await callRoute(router, 'get', '/:id', { params: { id: c1Shift } });
      check(r2.body?.open_session_count === 0 && r2.body?.open_session_clocked_in_at === null && r2.body?.has_session === true,
            `closed: 0, null, has_session true (got ${show([r2.body?.open_session_count, r2.body?.open_session_clocked_in_at])})`);
    }

    section('REM the clock-out reminder re-reads the current end (decision 11a under concurrency)');
    {
      // An extension clears the latch; a reminder tick that had already read the OLD end must not stamp it.
      const g = await mkGuard();
      const sh = await mkShift(g, -240, 3, 'active');     // the reminder window for the old end is open
      const ss = await mkSession(sh, g, -240);
      const adminTx = new Client(); await adminTx.connect();
      try {
        await adminTx.query('BEGIN');
        await adminTx.query(`SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE`, [sh]);
        await adminTx.query(`SELECT 1 FROM shift_sessions WHERE id = $1 FOR NO KEY UPDATE`, [ss]);
        await adminTx.query(`UPDATE shifts SET scheduled_end = $2 WHERE id = $1`, [sh, at(120)]);
        await adminTx.query(`UPDATE shift_sessions SET clock_out_reminder_sent_at = NULL WHERE id = $1`, [ss]);
        const tick = reminderMod.runClockOutReminder();
        await sleep(300);
        await adminTx.query('COMMIT');
        await tick;
        const se = await sessRow(ss);
        check(se.clock_out_reminder_sent_at === null,
              `a reminder tick racing an extension leaves the latch NULL for the new end (got ${se.clock_out_reminder_sent_at})`);
      } finally { await adminTx.end(); }
      // Control: with the end NOT moved, the same tick claims the session.
      const g2 = await mkGuard();
      const sh2 = await mkShift(g2, -240, 3, 'active');
      const ss2 = await mkSession(sh2, g2, -240);
      await reminderMod.runClockOutReminder();
      check((await sessRow(ss2)).clock_out_reminder_sent_at !== null, 'control: an unmoved shift in its window is claimed');
      void sh2;
    }

    section('M the missed-window INSERT re-checks the current end (decision 2a)');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -240, 240, 'active');
      const ss = await mkSession(sh, g, -240);
      if (!missedInsert?.missedWindowInsertSql) {
        check(false, 'services/missedWindowInsert.ts exists');
      } else {
        const sql = missedInsert.missedWindowInsertSql('missed_pings');
        const args = (ws: number, we: number) => [ss, siteId, g, at(ws), at(we), 'x', at(we + 60 * 24 * 90), sh];
        const other = new Client(); await other.connect();
        try {
          await other.query('BEGIN');
          await other.query(`SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE`, [sh]);
          await other.query(`UPDATE shifts SET scheduled_end = $2 WHERE id = $1`, [sh, at(-120)]);
          let done = false;
          const ins = pool.query(sql, args(-90, -60)).then((x: any) => { done = true; return x; });
          await sleep(300);
          check(!done, 'the INSERT waits while the close holds the shift row');
          await other.query('COMMIT');
          const res = await ins;
          check(res.rowCount === 0, `after the commit it writes nothing for a window past the new end (rows ${res.rowCount})`);
          const inWin = await pool.query(sql, args(-150, -120));
          check(inWin.rowCount === 1, 'a window ending at the new end is still written');
        } finally { await other.end(); }
      }
    }

    section('SW the sweep afterwards: a closed shift stays as the admin left it');
    {
      const before = { se: await sessRow(c1Sess), sh: await shiftRow(c1Shift) };
      const client = await pool.connect();
      try { await sweepMod.autoCompleteOverdueShifts(client); } finally { client.release(); }
      const after = { se: await sessRow(c1Sess), sh: await shiftRow(c1Shift) };
      check(ms(after.se.clocked_out_at) === ms(before.se.clocked_out_at) && after.se.clock_out_reason === 'admin_corrected'
            && Number(after.se.total_hours) === Number(before.se.total_hours) && after.sh.status === 'completed'
            && ms(after.sh.scheduled_end) === ms(before.sh.scheduled_end),
            'C1 unchanged by a sweep tick');
    }

    section('HAZARD (informational, not counted): why decision 7a exists');
    {
      // Raw SQL, NOT the route: the route refuses exactly this (G1). An extension committed while
      // a sweep tick that already judged the old end due is waiting on the session row.
      const g = await mkGuard();
      const sh = await mkShift(g, -240, -20, 'active');   // due: -20 + 15 <= now
      const ss = await mkSession(sh, g, -240);
      const adminTx = new Client(); await adminTx.connect();
      try {
        await adminTx.query('BEGIN');
        await adminTx.query(`SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE`, [sh]);
        await adminTx.query(`SELECT 1 FROM shift_sessions WHERE id = $1 FOR NO KEY UPDATE`, [ss]);
        await adminTx.query(`UPDATE shifts SET scheduled_end = $2 WHERE id = $1`, [sh, at(120)]);
        const client = await pool.connect();
        const tick = sweepMod.autoCompleteOverdueShifts(client).finally(() => client.release());
        await sleep(300);
        await adminTx.query('COMMIT');
        await tick;
        const se = await sessRow(ss); const s = await shiftRow(sh);
        console.log(`  · after the race: session clocked_out_at = ${se.clocked_out_at ? 'end ' + ((ms(se.clocked_out_at) - t0) / MIN) + ' min' : 'OPEN'}, ` +
                    `reason ${se.clock_out_reason}, shift ${s.status}, scheduled_end ${(ms(s.scheduled_end) - t0) / MIN} min`);
        console.log(se.clocked_out_at && ms(se.clocked_out_at) === at(-20).getTime() && s.status === 'active'
          ? '  · REPRODUCED: the sweep closed the extended session at its OLD end and left the shift active with no open session.'
          : '  · not reproduced on this run.');
      } finally { await adminTx.end(); }
    }
  } finally {
    if (!KEEP && companyId) {
      try {
        const scope = `(SELECT id FROM shift_sessions WHERE site_id IN (SELECT id FROM sites WHERE company_id = $1))`;
        for (const sql of [
          `DELETE FROM notifications WHERE guard_id IN (SELECT id FROM guards WHERE company_id = $1)`,
          `DELETE FROM missed_pings WHERE shift_session_id IN ${scope}`,
          `DELETE FROM missed_reports WHERE shift_session_id IN ${scope}`,
          `DELETE FROM break_sessions WHERE shift_session_id IN ${scope}`,
          `DELETE FROM geofence_violations WHERE shift_session_id IN ${scope}`,
          `DELETE FROM shift_swap_requests WHERE shift_id IN (SELECT id FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE company_id = $1))`,
          `DELETE FROM shift_sessions WHERE site_id IN (SELECT id FROM sites WHERE company_id = $1)`,
          `DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE company_id = $1)`,
          `DELETE FROM guard_devices WHERE guard_id IN (SELECT id FROM guards WHERE company_id = $1)`,
          `DELETE FROM guard_site_assignments WHERE guard_id IN (SELECT id FROM guards WHERE company_id = $1)`,
          `DELETE FROM guards WHERE company_id = $1`,
          `DELETE FROM sites WHERE company_id = $1`,
          `DELETE FROM companies WHERE id = $1 OR name = $2`,
        ]) await q(sql, sql.includes('$2') ? [companyId, `${marker}-other`] : [companyId]);
      } catch (err) {
        console.log(`  (cleanup incomplete — throwaway database: ${(err as Error).message})`);
      }
    }
    await pool.end();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
