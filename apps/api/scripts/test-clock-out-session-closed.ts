/**
 * test-clock-out-session-closed.ts — POST /api/shifts/:id/clock-out after the
 * session is already closed answers 409 SESSION_CLOSED; with no session to
 * find, the 404 stays byte-identical. End to end on a THROWAWAY LOCAL Postgres.
 *
 * The cases drive the real writers that close a session — the sweep
 * (jobs/autoCompleteShifts), the D20 admin close (PATCH /:id), the handoff
 * (POST /:id/handoff-clock-in) and the guard's own clock-out — plus a legacy
 * NULL-reason row, a handoff back (two sessions on one shift), a concurrent
 * close holding the row lock, and a rejected photo on a closed session.
 *
 * LOCAL DATABASES ONLY. The app pool (db/pool.ts) is built from DATABASE_URL
 * and falls back to PGHOST/PGPORT/PGDATABASE/PGUSER when that is unset; this
 * script REFUSES unless PGHOST is 127.0.0.1 or localhost, refuses if
 * DATABASE_URL points anywhere else, and re-asserts after import that the pool
 * carries no connection string. Point it at a FRESH database with the full
 * migration chain (db/migrate.ts) — the sweep in C1 is global, so leftovers
 * from another run would change what it closes, and the script REFUSES a
 * database that already holds any company. It writes one company of its own
 * and removes it at the end unless --keep is passed.
 *
 * Sentry, auth, email, S3, firebase and photo validation are replaced in
 * require.cache before the router loads (the test-active-shift-end-edit.ts
 * pattern). The photo stub accepts or rejects on demand and counts its calls.
 * No .env is read.
 *
 *   createdb -h 127.0.0.1 -p 5433 -U tester -T <migrated template> <fresh db>
 *   env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null PGHOST=127.0.0.1 PGPORT=5433 \
 *     PGDATABASE=<fresh db> PGUSER=tester npx ts-node scripts/test-clock-out-session-closed.ts
 *
 * Expected message strings are written out here, not imported, and responses
 * are compared as JSON round-trips — what the phone receives, not the objects
 * handed to res.json. Modules under test load as `any`, so the SAME file runs
 * against origin/main (the negative control): there the 409 checks fail and
 * every "unchanged" / 404 / 200 check passes. Checks never stop at the first
 * failure.
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
      : () => { throw new Error(`${name}.${String(prop)} called in the clock-out test`); }),
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
const show = (v: unknown): string => JSON.stringify(v);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
/** What the phone receives: the body after a JSON round trip. */
const wire = (v: unknown): any => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

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
  // header(): services/idempotency reads req.header('Idempotency-Key'); absent → pass-through.
  const fullReq: any = { query: {}, params: {}, body: {}, headers: {}, header: () => undefined, ...req };
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

/** The two 409 messages, written out here rather than imported. */
const M  = 'You are already clocked out of this shift. Go back to the home screen to refresh.';
const MN = `${M} Your handover notes may not have been saved. Give them to your supervisor.`;
const BODY_404 = '{"error":"Active session not found"}';

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
  // Recording, not refusing: handoff-clock-in (C3) emails the requester after
  // its commit, fire-and-forget, and a refusing stub would throw inside it.
  const emails: string[] = [];
  inject('../src/services/email', new Proxy({ __esModule: true }, {
    get: (target, prop) => (prop in target
      ? (target as Record<string | symbol, unknown>)[prop]
      : async () => { emails.push(String(prop)); }),
  }));
  inject('../src/services/s3', refusingModule('s3'));
  inject('../src/services/firebase', {
    sendPushNotification: async () => undefined,
    buildExpoPushMessage: () => ({}),
  });
  let photoVerdict: 'ok' | 'reject' = 'ok';
  let photoCalls = 0;
  const REJECTION = { error: 'PHOTO_REJECTED', reason: 'MAGIC_MISMATCH', message: 'That photo could not be verified.' };
  inject('../src/services/photoValidation', {
    validatePhotoOrQuarantine: async () => {
      photoCalls += 1;
      return photoVerdict === 'ok' ? { ok: true } : { ok: false, status: 400, body: REJECTION };
    },
  });

  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) {
    console.error('REFUSING: the app pool carries a connection string; unset DATABASE_URL.');
    process.exit(2);
  }
  // The C1 sweep commits on every overdue open session in the database, not
  // only on this script's fixtures: refuse anything but a fresh copy.
  const companies = Number((await pool.query(`SELECT count(*) AS n FROM companies`)).rows[0].n);
  if (companies !== 0) {
    console.error(`REFUSING: ${companies} companies already exist in this database; ` +
                  'point PGDATABASE at a fresh copy of the migrated template.');
    await pool.end();
    process.exit(2);
  }
  const router: any = (await import('../src/routes/shifts')).default;
  const sweepMod: any = await import('../src/jobs/autoCompleteShifts');
  for (const task of cron.getTasks().values()) task.stop();

  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `co409-${Date.now().toString(36)}`;
  let companyId = '';

  try {
    const t0 = ms((await q(`SELECT date_trunc('second', NOW()) AS t0`)).rows[0].t0);
    const at = (m: number): Date => new Date(t0 + m * MIN);

    // ── fixtures ────────────────────────────────────────────────────────────
    companyId = (await q(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [marker])).rows[0].id;
    const siteId = (await q(
      `INSERT INTO sites (company_id, name, address, timezone, contract_start)
       VALUES ($1, $2, 'addr', $3, CURRENT_DATE - 30) RETURNING id`, [companyId, `${marker} site`, TZ])).rows[0].id;
    const adminId = (await q(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const admin = { sub: adminId, role: 'company_admin', company_id: companyId };
    const asGuard = (g: string) => { actor = { sub: g, role: 'guard', company_id: companyId }; };

    let gN = 0;
    async function mkGuard(): Promise<string> {
      gN += 1;
      const id = (await q(
        `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
         VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
        [companyId, `${marker} g${gN}`, `${marker}-g${gN}@test.invalid`, `CO4${gN}`])).rows[0].id;
      await q(`INSERT INTO guard_devices (guard_id, push_token, last_seen_at) VALUES ($1, $2, NOW())`,
        [id, `ExponentPushToken[${marker}-g${gN}]`]);
      await q(`INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) VALUES ($1, $2, CURRENT_DATE - 30)`, [id, siteId]);
      return id;
    }
    const EXPIRES = at(60 * 24 * 1500);
    async function mkShift(guardId: string | null, s: number, e: number, status: string): Promise<string> {
      return (await q(
        `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, source, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6) RETURNING id`,
        [guardId, siteId, at(s), at(e), status, EXPIRES])).rows[0].id;
    }
    async function mkSession(shiftId: string, guardId: string, inM: number, outM: number | null = null,
                             reason: string | null = null): Promise<string> {
      return (await q(
        `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_out_reason, clock_in_coords)
         VALUES ($1, $2, $3, $4, $5, $6, '(0,0)') RETURNING id`,
        [shiftId, guardId, siteId, at(inM), outM === null ? null : at(outM), reason])).rows[0].id;
    }
    const shiftRow = async (id: string) => (await q(`SELECT * FROM shifts WHERE id = $1`, [id])).rows[0];
    const sessRow  = async (id: string) => (await q(`SELECT * FROM shift_sessions WHERE id = $1`, [id])).rows[0];
    const snap = async (sessionId: string, shiftId: string) =>
      JSON.stringify({ se: await sessRow(sessionId), sh: await shiftRow(shiftId) });
    /** Counted on a connection of its own. Through the app pool, pg-pool
     *  (LIFO) would hand the count the very client the route just released,
     *  and a transaction leaked on it reports that backend 'active'. */
    async function idleInTransaction(): Promise<number> {
      const c = new Client(); await c.connect();
      try {
        return Number((await c.query(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'idle in transaction'`)).rows[0].n);
      } finally { await c.end(); }
    }
    // Checked straight after EVERY clock-out: a later BEGIN/COMMIT on the same
    // pooled client would end a leaked transaction before a section-end check.
    const leaks: string[] = [];
    let clockOutCalls = 0;
    const clockOut = async (shiftId: string, body: Record<string, unknown> = {}) => {
      const r = await callRoute(router, 'post', '/:id/clock-out', { params: { id: shiftId }, body });
      clockOutCalls += 1;
      const n = await idleInTransaction();
      if (n !== 0) leaks.push(`call ${clockOutCalls} (answered ${r.status}): ${n}`);
      return r;
    };
    const patch = (shiftId: string, body: Record<string, unknown>) =>
      callRoute(router, 'patch', '/:id', { params: { id: shiftId }, body });

    /** One combined check, so the negative control counts one failure per case. */
    function expect409(r: Captured, iso: string, message: string, label: string): void {
      const w = wire(r.body);
      const keys = w && typeof w === 'object' ? Object.keys(w).sort().join(',') : '';
      check(r.status === 409 && keys === 'clocked_out_at,error,message' && w.error === 'SESSION_CLOSED'
            && w.message === message && w.clocked_out_at === iso,
            `${label}: 409 SESSION_CLOSED, clocked_out_at ${iso}, exact message, no other keys ` +
            `(got ${r.status} ${show(w)})`);
    }
    function expect404(r: Captured, label: string): void {
      check(r.status === 404 && JSON.stringify(wire(r.body)) === BODY_404,
            `${label}: 404 byte-identical ${BODY_404} (got ${r.status} ${show(wire(r.body))})`);
    }
    async function noIdleInTransaction(label: string): Promise<void> {
      const n = await idleInTransaction();
      check(n === 0, `${label}: no connection left idle in transaction (got ${n})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // C1 runs first: the sweep is global, and every other fixture is created
    // after it or ends in the future.
    section('C1 the sweep closed it -> 409 at the anchor; notes sentence when notes were sent');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -405, -45, 'active');
      const ss = await mkSession(sh, g, -400);
      const client = await pool.connect();
      try { await sweepMod.autoCompleteOverdueShifts(client); } finally { client.release(); }
      const se = await sessRow(ss);
      check(se.clock_out_reason === 'auto' && ms(se.clocked_out_at) === at(-45).getTime(),
            `precondition: swept, 'auto' at the scheduled end (got ${se.clock_out_reason} ${se.clocked_out_at})`);
      const before = await snap(ss, sh);
      asGuard(g);
      const r = await clockOut(sh, { handover_notes: 'gate 2 open' });
      expect409(r, at(-45).toISOString(), MN, 'C1');
      check(await snap(ss, sh) === before, 'C1: session and shift rows unchanged');
      const r2 = await clockOut(sh, { handover_notes: '   ' });
      expect409(r2, at(-45).toISOString(), M, 'C1 whitespace-only notes count as none');
      await noIdleInTransaction('C1');
    }

    section('C2 an admin closed it in the past (D20) -> 409 at the admin\'s end');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -480, 120, 'active');
      const ss = await mkSession(sh, g, -485);
      actor = admin;
      const p = await patch(sh, { scheduled_end: at(-90).toISOString(), confirm_close_session: true });
      const se = await sessRow(ss);
      check(p.status === 200 && se.clock_out_reason === 'admin_corrected' && ms(se.clocked_out_at) === at(-90).getTime(),
            `precondition: PATCH close 200, 'admin_corrected' at t-90 (got ${p.status} ${se.clock_out_reason})`);
      const before = await snap(ss, sh);
      asGuard(g);
      expect409(await clockOut(sh), at(-90).toISOString(), M, 'C2');
      check(await snap(ss, sh) === before, 'C2: session and shift rows unchanged');
    }

    section('C3 a handoff closed A\'s session -> A gets 409 with A\'s own time; B unaffected, then B clocks out');
    {
      const a = await mkGuard();
      const b = await mkGuard();
      const sh = await mkShift(a, -120, 120, 'active');
      const ssA = await mkSession(sh, a, -118);
      await q(`INSERT INTO shift_swap_requests (shift_id, from_guard_id, to_guard_id, initiated_by, status, accepted_at, from_session_id)
               VALUES ($1, $2, $3, 'guard_handoff', 'accepted', NOW(), $4)`, [sh, a, b, ssA]);
      asGuard(b);
      const h = await callRoute(router, 'post', '/:id/handoff-clock-in',
        { params: { id: sh }, body: { lat: 37.78, lng: -122.41, accuracy: 10 } });
      await sleep(300);   // the route's post-commit push/email work is unawaited
      const seA = await sessRow(ssA);
      const shRow = await shiftRow(sh);
      check(h.status === 201 && seA.clock_out_reason === `handed_off_to_${b}` && shRow.guard_id === b,
            `precondition: handoff 201, A's reason names B, shift now B's (got ${h.status} ${seA?.clock_out_reason} ${shRow.guard_id === b})`);
      const ssB = (await q(`SELECT id FROM shift_sessions WHERE shift_id = $1 AND guard_id = $2`, [sh, b])).rows[0]?.id;
      const beforeB = await snap(ssB, sh);
      asGuard(a);
      const rA = await clockOut(sh);
      const aIso = new Date(seA.clocked_out_at).toISOString();
      expect409(rA, aIso, M, 'C3 A');
      check(!JSON.stringify(wire(rA.body) ?? '').includes(b), 'C3: the 409 carries nothing of B (no uuid, no reason)');
      check(await snap(ssB, sh) === beforeB, 'C3: B\'s session and the shift are unchanged by A\'s attempt');
      asGuard(b);
      const rB = await clockOut(sh, { lat: 37.78, lng: -122.41, accuracy: 10 });
      check(rB.status === 200 && (await sessRow(ssB)).clocked_out_at !== null,
            `C3: B clocks out 200 (got ${rB.status} ${show(wire(rB.body))})`);
      asGuard(a);
      expect409(await clockOut(sh), aIso, M, 'C3 A again after B closed: still A\'s own time');
    }

    section('C4 own clock-out committed, response lost -> retry gets 409; the first write is kept');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -120, 60, 'active');
      const ss = await mkSession(sh, g, -118);
      asGuard(g);
      const r1 = await clockOut(sh, { handover_notes: 'first' });
      const first = await sessRow(ss);
      check(r1.status === 200 && first.clocked_out_at !== null, `precondition: first clock-out 200 (got ${r1.status})`);
      photoVerdict = 'ok';
      const callsBefore = photoCalls;
      const r2 = await clockOut(sh, { handover_notes: 'second', clock_out_photo_url: `https://example.invalid/${marker}.jpg` });
      expect409(r2, new Date(first.clocked_out_at).toISOString(), MN, 'C4');
      const after = await sessRow(ss);
      check(after.handover_notes === 'first' && after.clock_out_photo_url === null
            && after.clock_out_reason === first.clock_out_reason && String(after.total_hours) === String(first.total_hours),
            'C4: the retry wrote nothing — notes, photo, reason and hours are the first attempt\'s');
      check(photoCalls === callsBefore + 1, 'C4: the photo was validated before the lookup (ordering pinned)');
    }

    section('C5 a legacy closed row with no clock_out_reason -> 409');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -300, -200, 'completed');
      await mkSession(sh, g, -300, -200, null);
      asGuard(g);
      expect409(await clockOut(sh), at(-200).toISOString(), M, 'C5');
    }

    section('C6 a handoff back left two sessions -> the latest close is reported');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -240, 60, 'active');
      const fakeB = (await q(`SELECT gen_random_uuid() AS id`)).rows[0].id;
      await mkSession(sh, g, -200, -100, `handed_off_to_${fakeB}`);
      const open = await mkSession(sh, g, -30);
      asGuard(g);
      const r1 = await clockOut(sh);
      const second = await sessRow(open);
      check(r1.status === 200 && second.clocked_out_at !== null, `precondition: the open (second) session closes 200 (got ${r1.status})`);
      const r2 = await clockOut(sh);
      expect409(r2, new Date(second.clocked_out_at).toISOString(), M, 'C6 latest, not the handoff at t-100');
      check(!JSON.stringify(wire(r2.body) ?? '').includes(fakeB), 'C6: the first session\'s handoff reason is not on the wire');
    }

    section('C7 a concurrent close holds the row lock -> COMMIT: 409 at its time; ROLLBACK: 200');
    for (const outcome of ['COMMIT', 'ROLLBACK'] as const) {
      const g = await mkGuard();
      const sh = await mkShift(g, -120, 60, 'active');
      const ss = await mkSession(sh, g, -118);
      const other = new Client(); await other.connect();
      try {
        await other.query('BEGIN');
        await other.query(`UPDATE shift_sessions SET clocked_out_at = $2, clock_out_reason = 'auto' WHERE id = $1`, [ss, at(-5)]);
        asGuard(g);
        const pending = clockOut(sh);
        let waiting = 0;
        for (let i = 0; i < 40 && waiting === 0; i += 1) {
          waiting = Number((await q(
            `SELECT count(*) AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n);
          if (waiting === 0) await sleep(50);
        }
        check(waiting >= 1, `C7 ${outcome}: the clock-out is blocked on the row lock before the other side finishes`);
        await other.query(outcome);
        const r = await pending;
        if (outcome === 'COMMIT') expect409(r, at(-5).toISOString(), M, 'C7 COMMIT');
        else check(r.status === 200 && (await sessRow(ss)).clock_out_reason !== 'auto',
                   `C7 ROLLBACK: the clock-out proceeds 200 (got ${r.status} ${show(wire(r.body))})`);
      } finally { await other.end(); }
    }
    await noIdleInTransaction('C7');

    section('C8 nothing to find -> the 404, byte-identical, and nobody else\'s row touched');
    {
      const g = await mkGuard();
      const x = await mkGuard();
      asGuard(g);
      expect404(await clockOut((await q(`SELECT gen_random_uuid() AS id`)).rows[0].id), 'C8a unknown shift id');
      const never = await mkShift(g, 120, 300, 'scheduled');
      expect404(await clockOut(never), 'C8b own scheduled shift, never clocked in');
      const xClosed = await mkShift(x, -300, -200, 'completed');
      const xss = await mkSession(xClosed, x, -300, -200, 'manual');
      const xBefore = await snap(xss, xClosed);
      expect404(await clockOut(xClosed), 'C8c another guard\'s shift with a CLOSED session (guard filter)');
      check(await snap(xss, xClosed) === xBefore, 'C8c: the other guard\'s rows unchanged');
      const xOpen = await mkShift(x, -60, 60, 'active');
      const xos = await mkSession(xOpen, x, -58);
      expect404(await clockOut(xOpen), 'C8d another guard\'s shift with an OPEN session');
      check((await sessRow(xos)).clocked_out_at === null, 'C8d: that session is still open');
      const mine = await mkShift(g, -500, -400, 'completed');
      await mkSession(mine, g, -500, -400, 'manual');
      const otherShift = await mkShift(x, -380, -350, 'completed');
      expect404(await clockOut(otherShift), 'C8e closed on S1, POST to S2 never worked (shift filter)');
      await noIdleInTransaction('C8');
    }

    section('C9 a malformed shift id -> 500 as today (not a 404)');
    {
      const g = await mkGuard();
      asGuard(g);
      const r = await clockOut('not-a-uuid');
      check(r.status === 500 && JSON.stringify(wire(r.body)) === '{"error":"Failed to clock out"}',
            `C9: 500 {"error":"Failed to clock out"} (got ${r.status} ${show(wire(r.body))})`);
    }

    section('C10 an open session -> 200, response shape unchanged');
    {
      const g = await mkGuard();
      const sh = await mkShift(g, -120, 60, 'active');
      await mkSession(sh, g, -118);
      asGuard(g);
      const r = await clockOut(sh, { lat: 37.78, lng: -122.41, accuracy: 10, handover_notes: 'ok' });
      const w = wire(r.body);
      check(r.status === 200 && Object.keys(w ?? {}).sort().join(',')
              === 'clocked_in_at,clocked_out_at,handover_notes,id,scheduled_start,site_id,total_hours',
            `C10: 200 with the same keys (got ${r.status} ${Object.keys(w ?? {}).sort().join(',')})`);
      const s = await shiftRow(sh);
      check(s.status === 'completed', `C10: shift completed (got ${s.status})`);
      const reason = (await q(`SELECT clock_out_reason FROM shift_sessions WHERE shift_id = $1`, [sh])).rows[0].clock_out_reason;
      check(reason === 'manual_no_photo', `C10: reason manual_no_photo (got ${reason})`);
    }

    section('C11 a rejected photo: closed session -> 409; open session -> the 400 as before');
    {
      const g = await mkGuard();
      const closedSh = await mkShift(g, -300, -200, 'completed');
      await mkSession(closedSh, g, -300, -200, 'auto');
      asGuard(g);
      photoVerdict = 'reject';
      const r = await clockOut(closedSh, { clock_out_photo_url: `https://example.invalid/${marker}-c.jpg`, handover_notes: 'n' });
      expect409(r, at(-200).toISOString(), MN, 'C11 closed session + rejected photo');
      const h = await mkGuard();
      const openSh = await mkShift(h, -60, 60, 'active');
      const os = await mkSession(openSh, h, -58);
      asGuard(h);
      const r2 = await clockOut(openSh, { clock_out_photo_url: `https://example.invalid/${marker}-o.jpg` });
      check(r2.status === 400 && JSON.stringify(wire(r2.body)) === JSON.stringify(REJECTION),
            `C11 open session + rejected photo: the stub's 400 PHOTO_REJECTED, unchanged (got ${r2.status} ${show(wire(r2.body))})`);
      check((await sessRow(os)).clocked_out_at === null, 'C11: the open session stays open');
      photoVerdict = 'ok';
    }

    section('C12 closed on S1, open on S2 -> POST S1 is 409 for S1; S2 untouched');
    {
      const g = await mkGuard();
      const s1 = await mkShift(g, -600, -500, 'completed');
      await mkSession(s1, g, -600, -500, 'manual');
      const s2 = await mkShift(g, -60, 60, 'active');
      const s2s = await mkSession(s2, g, -58);
      const before = await snap(s2s, s2);
      asGuard(g);
      expect409(await clockOut(s1), at(-500).toISOString(), M, 'C12');
      check(await snap(s2s, s2) === before, 'C12: the open S2 session and its shift are unchanged');
    }

    check(clockOutCalls > 0 && leaks.length === 0,
          `no clock-out left a connection idle in transaction (${clockOutCalls} calls checked, each ` +
          `straight after it answered${leaks.length ? `; leaked: ${leaks.join('; ')}` : ''})`);
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
          `DELETE FROM companies WHERE id = $1`,
        ]) await q(sql, [companyId]);
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
