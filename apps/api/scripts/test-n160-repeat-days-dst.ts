/**
 * test-n160-repeat-days-dst.ts — N160 end to end on a THROWAWAY LOCAL Postgres:
 * POST /api/shifts repeat_days builds every window at the site's wall clock
 * (R), the PATCH /:id notice is unchanged after its move to
 * services/shiftEditPush.ts (P), and the one-off correction finds, refuses and
 * applies exactly what it should (C, src/ops/n160DstCorrection.ts).
 *
 * THE PROCESS CLOCK IS PART OF THE TEST. The old repeat_days loop used the
 * server's local time, which is UTC on Railway and America/Los_Angeles on this
 * Mac, and only UTC shows the bug. Run it three times:
 *
 *   for z in UTC America/Los_Angeles Asia/Kolkata; do
 *     TZ=$z PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=n160test PGUSER=tester \
 *       npx ts-node scripts/test-n160-repeat-days-dst.ts; done        (from apps/api)
 *
 * It refuses unless TZ is one of those three and the process actually reads
 * 2026-11-01T17:00Z in it as expected (Asia/Kolkata has no DST and a
 * half-hour offset). It refuses unless PGHOST is local, DATABASE_URL is unset
 * or local, the database name ends in "test", and the database holds no
 * shifts; it empties the company tables at the end (TRUNCATE ... CASCADE).
 * Point it at a database with the full migration chain replayed
 * (db/migrate.ts), set to TimeZone Etc/UTC like production.
 *
 * Sentry, auth, email, S3 and firebase are replaced in require.cache before
 * the router loads (the test-active-shift-end-edit.ts pattern); the firebase
 * stub records pushes. No .env is read.
 *
 * EXPECTED INSTANTS ARE WRITTEN OUT as ISO strings, never computed by the code
 * under test. Every check has an id; a failure prints it as [id], so the same
 * file run against origin/main's route (the negative control) or a mutation
 * reports exactly which checks fail. The correction module is loaded through
 * a non-literal specifier, so on origin/main, where it does not exist, the
 * file still compiles and reports [C.module].
 *
 * The R dates are fixed around the 2026-11-01 and 2027-03-14 DST changes and
 * must be in the future: it refuses to run on or after 2026-10-18.
 */
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LA = 'America/Los_Angeles';
const LONDON = 'Europe/London';
const PROBE_HOUR: Record<string, string> = { UTC: '17:00', [LA]: '09:00', 'Asia/Kolkata': '22:30' };

function refuse(msg: string): never { console.error(`REFUSING: ${msg}`); process.exit(2); }
function refuseUnlessSafe(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) refuse(`PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`);
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) refuse('PGDATABASE must end in "test".');
  const url = process.env.DATABASE_URL;
  if (url) {
    let urlHost = '';
    try { urlHost = new URL(url).hostname; } catch { urlHost = '(unparseable)'; }
    if (!LOCAL_HOSTS.has(urlHost)) refuse(`DATABASE_URL points at ${urlHost}; unset it.`);
  }
  const tz = process.env.TZ ?? '';
  const probe = new Date('2026-11-01T17:00:00.000Z');
  const read = `${String(probe.getHours()).padStart(2, '0')}:${String(probe.getMinutes()).padStart(2, '0')}`;
  if (!(tz in PROBE_HOUR) || PROBE_HOUR[tz] !== read) {
    refuse(`TZ must be one of ${Object.keys(PROBE_HOUR).join(', ')} and read 2026-11-01T17:00Z as expected (TZ=${tz || 'unset'}, read ${read}).`);
  }
  console.log(`process TZ ${tz}: reads 2026-11-01T17:00Z as ${read} local (verified)`);
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
      : () => { throw new Error(`${name}.${String(prop)} called in the N160 test`); }),
  });
}

let failures = 0;
let passes = 0;
function check(id: string, cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ [${id}] ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL [${id}] ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const ms = (v: unknown): number => (v === null || v === undefined ? NaN : new Date(v as string).getTime());
const iso = (v: unknown): string => (v === null || v === undefined ? String(v) : new Date(v as string).toISOString());
const show = (v: unknown): string => JSON.stringify(v);
/** JSON with keys sorted: jsonb returns object keys in its own order. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();
/** 'HH:MM' and 'YYYY-MM-DD' at a zone, written independently of the code under test. */
const hm = (d: unknown, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(d as string));
const ymd = (d: unknown, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(new Date(d as string));
const nextDay = (s: string): string => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/**
 * The OLD repeat_days loop as it runs on Railway, where the process clock is
 * UTC: origin/main's routes/shifts.ts with setHours/setDate read as their UTC
 * forms (identical when TZ=UTC). The C seeds come from it, so they are what
 * production's old code wrote; [C.oldloop] checks it against production's
 * Bethel rows and against origin/main's own output for R5 under TZ=UTC.
 */
const DOW: Record<string, number> = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
function oldLoopUtc(start: string, end: string, days: number[], tz: string): Array<[string, string]> {
  const baseStart = new Date(start);
  const durationMs = new Date(end).getTime() - baseStart.getTime();
  const horizon = new Date(baseStart);
  horizon.setUTCDate(horizon.getUTCDate() + 28);
  const out: Array<[string, string]> = [];
  const cur = new Date(baseStart);
  while (cur <= horizon) {
    const dow = DOW[new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(cur)];
    if (days.includes(dow)) {
      const s = new Date(cur);
      s.setUTCHours(baseStart.getUTCHours(), baseStart.getUTCMinutes(), baseStart.getUTCSeconds(), 0);
      out.push([s.toISOString(), new Date(s.getTime() + durationMs).toISOString()]);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

interface Captured { status: number; body: any; threw?: unknown }
async function callRoute(router: any, method: 'post' | 'patch', path: string, req: Record<string, unknown>): Promise<Captured> {
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

async function main(): Promise<void> {
  refuseUnlessSafe();

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
  if (pool.options?.connectionString) refuse('the app pool carries a connection string; unset DATABASE_URL.');
  const router: any = (await import('../src/routes/shifts')).default;
  const retention: any = await import('../src/services/retention');
  // Non-literal, so origin/main (no such module) still compiles; [C.module] then fails.
  const correctionPath = '../src/ops/n160DstCorrection';
  let n160: any = null;
  try { n160 = await import(correctionPath); } catch { n160 = null; }
  for (const task of cron.getTasks().values()) task.stop();

  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `n160-${Date.now().toString(36)}`;

  try {
    if ((await q(`SELECT NOW() >= TIMESTAMPTZ '2026-10-18 00:00:00+00' AS late`)).rows[0].late) {
      refuse('the fixed R dates are no longer in the future; re-date the cases.');
    }
    if ((await q(`SELECT current_setting('TimeZone') AS tz`)).rows[0].tz !== 'Etc/UTC') {
      refuse('the database TimeZone must be Etc/UTC, as in production.');
    }
    if ((await q(`SELECT COUNT(*)::int AS n FROM shifts`)).rows[0].n !== 0) {
      refuse('the database already holds shifts; start from an empty one.');
    }

    // ── fixtures ────────────────────────────────────────────────────────────
    const companyId = (await q(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [marker])).rows[0].id;
    const mkSite = async (name: string, tz: string, active = true): Promise<string> => {
      const id = (await q(
        `INSERT INTO sites (company_id, name, address, timezone, contract_start)
         VALUES ($1, $2, 'addr', $3, CURRENT_DATE - 30) RETURNING id`, [companyId, `${marker} ${name}`, tz])).rows[0].id;
      if (!active) await q(`UPDATE sites SET is_active = false WHERE id = $1`, [id]);
      return id;
    };
    const siteA = await mkSite('A', LA);
    const siteName = `${marker} A`;
    const siteOff = await mkSite('inactive', LA, false);
    const siteLon = await mkSite('London', LONDON);
    const siteC = await mkSite('C', LA);
    const siteCName = `${marker} C`;

    let gN = 0;
    const tokenOf = new Map<string, string>();
    async function mkGuard(site: string): Promise<string> {
      gN += 1;
      const id = (await q(
        `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
         VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
        [companyId, `${marker} g${gN}`, `${marker}-g${gN}@test.invalid`, `N160T${gN}`])).rows[0].id;
      const token = `ExponentPushToken[${marker}-g${gN}]`;
      await q(`INSERT INTO guard_devices (guard_id, push_token, last_seen_at) VALUES ($1, $2, NOW())`, [id, token]);
      await q(`INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) VALUES ($1, $2, CURRENT_DATE - 30)`, [id, site]);
      tokenOf.set(id, token);
      return id;
    }
    const pushFor = (guardId: string) => pushes.filter((p) => p.token === tokenOf.get(guardId));
    async function insertShift(p: {
      guardId: string | null; siteId: string; start: string; end: string; status: string;
      creator: string; createdAt?: string;
    }): Promise<string> {
      return (await q(
        `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, source, expires_at,
                             created_by, created_by_role, created_at)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, 'company_admin', COALESCE($8::timestamptz, NOW()))
         RETURNING id`,
        [p.guardId, p.siteId, p.start, p.end, p.status, retention.expiresAtFor('shift', new Date(p.start)),
         p.creator, p.createdAt ?? null])).rows[0].id;
    }
    const rowsBy = async (creator: string) => (await q(
      `SELECT id, guard_id, status, scheduled_start, scheduled_end FROM shifts WHERE created_by = $1
        ORDER BY scheduled_start`, [creator])).rows;
    const pairs = (rows: any[]) => rows.map((r) => `${iso(r.scheduled_start)}→${iso(r.scheduled_end)}`);
    const post = async (body: Record<string, unknown>): Promise<{ r: Captured; creator: string }> => {
      const creator = randomUUID();                         // one admin per request: one series per batch
      actor = { sub: creator, role: 'company_admin', company_id: companyId };
      return { r: await callRoute(router, 'post', '/', { body }), creator };
    };
    const repeat = (start: string, end: string, days: unknown, extra: Record<string, unknown> = {}) =>
      post({ site_id: siteA, scheduled_start: start, scheduled_end: end, repeat_days: days, ...extra });
    const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
    const rIds: Record<string, string[]> = {};

    // ════════════════════════════════════════════════════════════════════════
    section('R1 Bethel shape: Sundays 09:00–15:00 from Sun Oct 25 2026 (09:00 PDT = 16:00Z)');
    {
      const g = await mkGuard(siteA);
      const { r, creator } = await repeat('2026-10-25T16:00:00.000Z', '2026-10-25T22:00:00.000Z', [0], { guard_id: g });
      const rows = await rowsBy(creator);
      rIds.R1 = rows.map((x: any) => x.id);
      check('R1.status', r.status === 201 && rows.length === 5, `201 and 5 shifts (got ${r.status}, ${rows.length})`);
      check('R1.oct', rows[0] && iso(rows[0].scheduled_start) === '2026-10-25T16:00:00.000Z' && iso(rows[0].scheduled_end) === '2026-10-25T22:00:00.000Z',
            `Oct 25 at 16:00Z–22:00Z, as sent (got ${pairs(rows.slice(0, 1))})`);
      const nov = ['01', '08', '15', '22'].map((d) => `2026-11-${d}T17:00:00.000Z→2026-11-${d}T23:00:00.000Z`);
      check('R1.nov', show(pairs(rows.slice(1))) === show(nov),
            `Nov 1/8/15/22 at 17:00Z–23:00Z = 09:00–15:00 PST (got ${show(pairs(rows.slice(1)))})`);
    }

    section('R2 STARNET overnight: every night 18:00 -> 06:00 from Fri Oct 30 2026');
    {
      const g = await mkGuard(siteA);
      const first = await repeat('2026-10-31T01:00:00.000Z', '2026-10-31T13:00:00.000Z', ALL_DAYS, { guard_id: g });
      const before = await rowsBy(first.creator);
      const b = first.r.body ?? {};
      check('R2.ask', first.r.status === 409 && b.code === 'LONG_SHIFT_CONFIRM_REQUIRED'
            && b.scheduled_start === '2026-11-01T01:00:00.000Z' && b.scheduled_end === '2026-11-01T14:00:00.000Z'
            && b.duration_minutes === 780 && b.ends_at_label === 'Ends Sun Nov 1, 06:00 — 13h' && before.length === 0,
            `no confirm: 409 for the Oct 31 night, 13 h, nothing written (got ${first.r.status} ${show(b)}, ${before.length} rows)`);
      const { r, creator } = await repeat('2026-10-31T01:00:00.000Z', '2026-10-31T13:00:00.000Z', ALL_DAYS,
        { guard_id: g, confirm_long_shift: true });
      const rows = await rowsBy(creator);
      const all = [...before, ...rows];
      rIds.R2 = all.map((x: any) => x.id);
      check('R2.status', r.status === 201 && rows.length === 29, `with confirm: 201 and 29 shifts (got ${r.status} ${r.status !== 201 ? show(r.body) : ''}, ${rows.length})`);
      const bad = all.filter((x: any) => hm(x.scheduled_start, LA) !== '18:00' || hm(x.scheduled_end, LA) !== '06:00'
        || ymd(x.scheduled_end, LA) !== nextDay(ymd(x.scheduled_start, LA)));
      check('R2.wall', all.length > 0 && bad.length === 0,
            `every shift 18:00 -> 06:00 next day at the site (${bad.length} of ${all.length} not: ${show(pairs(bad.slice(0, 3)))})`);
      const oct31 = all.find((x: any) => iso(x.scheduled_start) === '2026-11-01T01:00:00.000Z');
      check('R2.oct31', !!oct31 && iso(oct31.scheduled_end) === '2026-11-01T14:00:00.000Z',
            `the Oct 31 night ends 06:00 PST = 14:00Z, 13 h (got ${oct31 ? iso(oct31.scheduled_end) : 'no such shift'})`);
    }

    section('R3 spring: Sundays 02:30–03:00 from Mar 7 2027; on Mar 14 02:30 does not exist');
    {
      const { r, creator } = await repeat('2027-03-07T10:30:00.000Z', '2027-03-07T11:00:00.000Z', [0]);
      const rows = await rowsBy(creator);
      check('R3.refused', r.status === 422 && r.body?.code === 'END_NOT_AFTER_START' && /2027-03-14/.test(r.body?.error ?? '')
            && rows.length === 0, `422 END_NOT_AFTER_START naming 2027-03-14, nothing written (got ${r.status} ${show(r.body)}, ${rows.length} rows)`);
    }

    section('R4 a Wednesday start, Sundays only: every shift falls after the change');
    {
      const g = await mkGuard(siteA);
      const { r, creator } = await repeat('2026-10-28T16:00:00.000Z', '2026-10-29T00:00:00.000Z', [0], { guard_id: g });
      const rows = await rowsBy(creator);
      rIds.R4 = rows.map((x: any) => x.id);
      check('R4.count', r.status === 201 && rows.length === 4, `201 and 4 shifts, Nov 1–22 (got ${r.status}, ${rows.length})`);
      const want = [['01', '02'], ['08', '09'], ['15', '16'], ['22', '23']]
        .map(([s, e]) => `2026-11-${s}T17:00:00.000Z→2026-11-${e}T01:00:00.000Z`);
      check('R4.times', show(pairs(rows)) === show(want), `09:00–17:00 PST = 17:00Z–01:00Z (got ${show(pairs(rows))})`);
    }

    section('R5 near midnight: Sundays 00:30–08:30 from Oct 25 2026, unassigned');
    {
      const { r, creator } = await repeat('2026-10-25T07:30:00.000Z', '2026-10-25T15:30:00.000Z', [0]);
      const rows = await rowsBy(creator);
      rIds.R5 = rows.map((x: any) => x.id);
      check('R5.count', r.status === 201 && rows.length === 5, `201 and 5 shifts (got ${r.status}, ${rows.length})`);
      const want = [
        '2026-10-25T07:30:00.000Z→2026-10-25T15:30:00.000Z',
        '2026-11-01T07:30:00.000Z→2026-11-01T16:30:00.000Z',
        '2026-11-08T08:30:00.000Z→2026-11-08T16:30:00.000Z',
        '2026-11-15T08:30:00.000Z→2026-11-15T16:30:00.000Z',
        '2026-11-22T08:30:00.000Z→2026-11-22T16:30:00.000Z',
      ];
      check('R5.times', show(pairs(rows)) === show(want), `each Sunday 00:30 -> 08:30 at the site (got ${show(pairs(rows))})`);
    }

    section('R6 overlap, both ways: the check tests the windows the INSERT writes');
    {
      const g4 = await mkGuard(siteA);
      const blocker = await insertShift({ guardId: g4, siteId: siteA, start: '2026-11-01T22:30:00.000Z', end: '2026-11-02T00:00:00.000Z',
        status: 'scheduled', creator: randomUUID() });
      const a = await repeat('2026-10-25T16:00:00.000Z', '2026-10-25T22:00:00.000Z', [0], { guard_id: g4 });
      const aRows = await rowsBy(a.creator);
      check('R6a.conflict', a.r.status === 409 && a.r.body?.conflict?.shift_id === blocker && aRows.length === 0,
            `Nov 1 14:30–16:00 PST blocks the corrected 09:00–15:00 window: 409 naming it, nothing written (got ${a.r.status} ${show(a.r.body?.conflict?.shift_id)}, ${aRows.length} rows)`);
      const g5 = await mkGuard(siteA);
      await insertShift({ guardId: g5, siteId: siteA, start: '2026-11-01T15:30:00.000Z', end: '2026-11-01T16:30:00.000Z',
        status: 'scheduled', creator: randomUUID() });
      const b = await repeat('2026-10-25T16:00:00.000Z', '2026-10-25T22:00:00.000Z', [0], { guard_id: g5 });
      const bRows = await rowsBy(b.creator);
      rIds.R6b = bRows.map((x: any) => x.id);
      check('R6b.created', b.r.status === 201 && bRows.length === 5,
            `Nov 1 07:30–08:30 PST does not block 09:00–15:00: 201, 5 shifts (got ${b.r.status} ${b.r.status !== 201 ? show(b.r.body) : ''}, ${bRows.length})`);
    }

    section('R7 a deactivated site: single and repeat_days refuse, as specific_dates always has');
    {
      const deact = 'Site is deactivated. Reactivate it before scheduling shifts.';
      const s = await post({ site_id: siteOff, scheduled_start: '2026-11-03T17:00:00.000Z', scheduled_end: '2026-11-03T23:00:00.000Z' });
      check('R7.single', s.r.status === 409 && s.r.body?.error === deact, `single -> 409 (got ${s.r.status} ${show(s.r.body)})`);
      const rp = await post({ site_id: siteOff, scheduled_start: '2026-10-25T16:00:00.000Z', scheduled_end: '2026-10-25T22:00:00.000Z', repeat_days: [0] });
      check('R7.repeat', rp.r.status === 409 && rp.r.body?.error === deact, `repeat_days -> 409 (got ${rp.r.status} ${show(rp.r.body)})`);
      const sd = await post({ mode: 'specific_dates', site_id: siteOff, start_time: '09:00', end_time: '15:00', dates: ['2026-11-03'] });
      check('R7.sd', sd.r.status === 409 && sd.r.body?.error === deact, `specific_dates -> 409, unchanged (got ${sd.r.status})`);
      const n = (await q(`SELECT COUNT(*)::int AS n FROM shifts WHERE site_id = $1`, [siteOff])).rows[0].n;
      check('R7.none', n === 0, `no shift at the deactivated site (got ${n})`);
    }

    section('R8 repeat_days values are whole numbers 0–6');
    {
      const bad: Array<{ v: unknown; status: number; n: number; err: string }> = [];
      for (const v of [['0'], [7], [-1], [1.5], [0, 7]]) {
        const { r, creator } = await repeat('2026-10-26T16:00:00.000Z', '2026-10-26T22:00:00.000Z', v);
        bad.push({ v, status: r.status, n: (await rowsBy(creator)).length, err: r.body?.error });
      }
      check('R8.reject', bad.every((b) => b.status === 422 && b.err === 'repeat_days must be whole numbers from 0 (Sunday) to 6 (Saturday).'),
            `['0'], [7], [-1], [1.5], [0,7] -> 422 (got ${show(bad.map((b) => [b.v, b.status]))})`);
      check('R8.none', bad.every((b) => b.n === 0), `nothing written (got ${show(bad.map((b) => [b.v, b.n]))})`);
    }

    section('R9 single is unchanged: the client\'s instants, as sent');
    {
      const g = await mkGuard(siteA);
      const { r, creator } = await post({ site_id: siteA, guard_id: g,
        scheduled_start: '2026-11-01T17:00:00.000Z', scheduled_end: '2026-11-01T23:00:00.000Z' });
      const rows = await rowsBy(creator);
      check('R9.same', r.status === 201 && show(pairs(rows)) === show(['2026-11-01T17:00:00.000Z→2026-11-01T23:00:00.000Z']),
            `201, stored as sent (got ${r.status} ${show(pairs(rows))})`);
    }

    section('R10 day 0 inside the repeated hour: Sun Nov 1 01:30 (sent as PDT, 08:30Z) -> 05:30');
    {
      const { r, creator } = await repeat('2026-11-01T08:30:00.000Z', '2026-11-01T13:30:00.000Z', [0]);
      const rows = await rowsBy(creator);
      rIds.R10 = rows.map((x: any) => x.id);
      const sd = await post({ mode: 'specific_dates', site_id: siteA, start_time: '01:30', end_time: '05:30', dates: ['2026-11-01'] });
      const sdRows = await rowsBy(sd.creator);
      check('R10.sd', sd.r.status === 201 && show(pairs(sdRows)) === show(['2026-11-01T09:30:00.000Z→2026-11-01T13:30:00.000Z']),
            `specific_dates reads 01:30 as the later, PST, instant: 09:30Z (got ${show(pairs(sdRows))})`);
      check('R10.day0', r.status === 201 && rows[0] && pairs(rows)[0] === pairs(sdRows)[0],
            `repeat_days day 0 takes the same reading (got ${r.status} ${show(pairs(rows.slice(0, 1)))})`);
      const rest = ['08', '15', '22', '29'].map((d) => `2026-11-${d}T09:30:00.000Z→2026-11-${d}T13:30:00.000Z`);
      check('R10.rest', show(pairs(rows.slice(1))) === show(rest), `Nov 8–29 at 01:30–05:30 PST (got ${show(pairs(rows.slice(1)))})`);
    }

    section('R11 spring overnight: every night 18:00 -> 06:00 from Mon Mar 8 2027');
    {
      const g = await mkGuard(siteA);
      const { r, creator } = await repeat('2027-03-09T02:00:00.000Z', '2027-03-09T14:00:00.000Z', ALL_DAYS, { guard_id: g });
      const rows = await rowsBy(creator);
      check('R11.status', r.status === 201 && rows.length === 29, `201 and 29 shifts, no confirm (the short night is 11 h) (got ${r.status} ${r.status !== 201 ? show(r.body) : ''}, ${rows.length})`);
      const bad = rows.filter((x: any) => hm(x.scheduled_start, LA) !== '18:00' || hm(x.scheduled_end, LA) !== '06:00');
      check('R11.wall', rows.length > 0 && bad.length === 0, `every shift 18:00 -> 06:00 (${bad.length} not: ${show(pairs(bad.slice(0, 3)))})`);
      const mar13 = rows.find((x: any) => iso(x.scheduled_start) === '2027-03-14T02:00:00.000Z');
      check('R11.mar13', !!mar13 && iso(mar13.scheduled_end) === '2027-03-14T13:00:00.000Z',
            `the Mar 13 night ends 06:00 PDT = 13:00Z, 11 h (got ${mar13 ? iso(mar13.scheduled_end) : 'no such shift'})`);
    }

    section('R12 a 13 h base still asks (control)');
    {
      const { r } = await repeat('2026-10-28T02:00:00.000Z', '2026-10-28T15:00:00.000Z', [2]);
      check('R12.ask', r.status === 409 && r.body?.code === 'LONG_SHIFT_CONFIRM_REQUIRED' && r.body?.duration_minutes === 780,
            `409, 780 min (got ${r.status} ${show(r.body?.duration_minutes)})`);
    }

    section('R13 a London site: the SITE\'s zone, not Los Angeles (BST ends Oct 25 2026)');
    {
      const { r, creator } = await post({ site_id: siteLon, scheduled_start: '2026-10-18T08:00:00.000Z',
        scheduled_end: '2026-10-18T16:00:00.000Z', repeat_days: [0] });
      const rows = await rowsBy(creator);
      rIds.R13 = rows.map((x: any) => x.id);
      const want = [
        '2026-10-18T08:00:00.000Z→2026-10-18T16:00:00.000Z',
        ...['10-25', '11-01', '11-08', '11-15'].map((d) => `2026-${d}T09:00:00.000Z→2026-${d}T17:00:00.000Z`),
      ];
      check('R13.times', r.status === 201 && show(pairs(rows)) === show(want), `09:00–17:00 London every Sunday (got ${r.status} ${show(pairs(rows))})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    section('P1 PATCH /:id as the super-admin: the guard\'s notice is unchanged');
    {
      const g = await mkGuard(siteA);
      const sh = await insertShift({ guardId: g, siteId: siteA, start: '2026-11-03T17:00:00.000Z', end: '2026-11-04T01:00:00.000Z',
        status: 'scheduled', creator: randomUUID() });
      actor = { sub: '00000000-0000-0000-0000-000000000000', role: 'vishnu' };
      const r = await callRoute(router, 'patch', '/:id', { params: { id: sh },
        body: { scheduled_start: '2026-11-03T18:00:00.000Z', scheduled_end: '2026-11-04T02:00:00.000Z' } });
      check('P1.status', r.status === 200, `200 (got ${r.status} ${r.status !== 200 ? show(r.body) : ''})`);
      let n: any = null;
      for (let i = 0; i < 40 && !n; i += 1) {
        n = (await q(`SELECT title, body, data FROM notifications WHERE guard_id = $1 AND type = 'shift_schedule_edited'`, [g])).rows[0] ?? null;
        if (!n) await sleep(50);
      }
      const t = (d: string) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: LA }).format(new Date(d));
      const body = `Now Nov 3, ${t('2026-11-03T18:00:00.000Z')} – ${t('2026-11-04T02:00:00.000Z')}. Tap to view details.`;
      const data = { type: 'shift_schedule_edited', shift_id: sh, scheduled_start: '2026-11-03T18:00:00.000Z', scheduled_end: '2026-11-04T02:00:00.000Z' };
      check('P1.notif', n?.title === `Shift time changed at ${siteName}` && n?.body === body && canon(n?.data) === canon(data),
            `notification row (got ${show(n)})`);
      await sleep(100);
      const p = pushFor(g);
      check('P1.push', p.length === 1 && p[0].title === n?.title && p[0].body === body && canon(p[0].data) === canon(data),
            `one push, same text and data (got ${show(p)})`);
      const a = (await q(`SELECT changed_by, changed_by_role FROM shift_schedule_audit WHERE shift_id = $1`, [sh])).rows;
      check('P1.audit', a.length === 1 && a[0].changed_by === '00000000-0000-0000-0000-000000000000' && a[0].changed_by_role === 'vishnu',
            `audit row under the super-admin sub (got ${show(a)})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    section('C the correction: src/ops/n160DstCorrection.ts');
    check('C.module', !!n160, 'the correction module loads');
    if (n160) {
      const NOW_C = new Date('2026-10-26T12:00:00.000Z');       // after October's Sundays, before Nov 1
      const seed = async (p: { guardId: string | null; creator: string; createdAt: string; rows: Array<[string, string, string]> }) => {
        const ids: string[] = [];
        for (let i = 0; i < p.rows.length; i += 1) {
          const [start, end, status] = p.rows[i];
          ids.push(await insertShift({ guardId: p.guardId, siteId: siteC, start, end, status, creator: p.creator,
            createdAt: new Date(new Date(p.createdAt).getTime() + i * 5).toISOString() }));
        }
        return ids;
      };
      // Shifts already over at the pinned clock are completed; the rest are open.
      const asOld = (pairs: Array<[string, string]>, open: string, now: Date): Array<[string, string, string]> =>
        pairs.map(([s, e]) => [s, e, new Date(e) <= now ? 'completed' : open]);
      const BETHEL = oldLoopUtc('2026-10-04T16:00:00.000Z', '2026-10-04T22:00:00.000Z', [0], LA);
      const R5_MAIN_UTC = oldLoopUtc('2026-10-25T07:30:00.000Z', '2026-10-25T15:30:00.000Z', [0], LA);
      check('C.oldloop',
        show(BETHEL) === show(['10-04', '10-11', '10-18', '10-25', '11-01'].map((d) => [`2026-${d}T16:00:00.000Z`, `2026-${d}T22:00:00.000Z`]))
        && show(R5_MAIN_UTC) === show([['10-25', '10-25'], ['11-01', '11-01'], ['11-02', '11-02'], ['11-09', '11-09'], ['11-16', '11-16']]
          .map(([a, b]) => [`2026-${a}T07:30:00.000Z`, `2026-${b}T15:30:00.000Z`])),
        'the ported old loop writes production\'s Bethel rows (read 2026-09-30) and origin/main\'s own R5 rows under TZ=UTC: Sunday Nov 1 twice, no Nov 22');
      const bethel = (): Array<[string, string, string]> => asOld(BETHEL, 'scheduled', NOW_C);
      // C1 the Bethel series as the old loop wrote it: Oct members done, Nov 1 an hour early.
      const g10 = await mkGuard(siteC);
      const c1 = await seed({ guardId: g10, creator: randomUUID(), createdAt: '2026-09-29T17:20:47.100Z', rows: bethel() });
      await q(`UPDATE shifts SET pre_shift_reminder_sent_at = '2026-10-31T16:00:00Z' WHERE id = $1`, [c1[4]]);
      // C2 one guard, a day series and a night series, back to back, 10 s apart.
      const g11 = await mkGuard(siteC);
      const creatorB = randomUUID();
      const day = await seed({ guardId: g11, creator: creatorB, createdAt: '2026-10-20T10:00:00.000Z', rows: [
        ['2026-10-30T13:00:00.000Z', '2026-10-31T01:00:00.000Z', 'scheduled'], ['2026-10-31T13:00:00.000Z', '2026-11-01T01:00:00.000Z', 'scheduled'],
        ['2026-11-01T13:00:00.000Z', '2026-11-02T01:00:00.000Z', 'scheduled'], ['2026-11-02T13:00:00.000Z', '2026-11-03T01:00:00.000Z', 'scheduled'] ] });
      const night = await seed({ guardId: g11, creator: creatorB, createdAt: '2026-10-20T10:00:10.000Z', rows: [
        ['2026-10-31T01:00:00.000Z', '2026-10-31T13:00:00.000Z', 'scheduled'], ['2026-11-01T01:00:00.000Z', '2026-11-01T13:00:00.000Z', 'scheduled'],
        ['2026-11-02T01:00:00.000Z', '2026-11-02T13:00:00.000Z', 'scheduled'], ['2026-11-03T01:00:00.000Z', '2026-11-03T13:00:00.000Z', 'scheduled'] ] });
      // C3 near midnight, unassigned: Sundays 00:30–08:30 as the old loop wrote them (R5's base).
      const c3 = await seed({ guardId: null, creator: randomUUID(), createdAt: '2026-10-20T11:00:00.000Z',
        rows: asOld(R5_MAIN_UTC, 'unassigned', NOW_C) });
      // C4 a Wednesday base, Sundays only (R4's base): every shift after the change, all equally early.
      const g12 = await mkGuard(siteC);
      const c4 = await seed({ guardId: g12, creator: randomUUID(), createdAt: '2026-10-01T15:00:00.000Z',
        rows: asOld(oldLoopUtc('2026-10-28T16:00:00.000Z', '2026-10-29T00:00:00.000Z', [0], LA), 'scheduled', NOW_C) });
      // C6 the Bethel shape again, but a later single shift blocks the corrected window.
      const g13 = await mkGuard(siteC);
      const creatorE = randomUUID();
      const c6 = await seed({ guardId: g13, creator: creatorE, createdAt: '2026-09-29T18:00:00.000Z', rows: bethel() });
      const c6block = await insertShift({ guardId: g13, siteId: siteC, start: '2026-11-01T22:30:00.000Z', end: '2026-11-01T23:30:00.000Z',
        status: 'scheduled', creator: creatorE, createdAt: '2026-10-02T09:00:00.000Z' });
      // C8 the Bethel shape, its Nov 1 shift carrying a session.
      const g16 = await mkGuard(siteC);
      const c8 = await seed({ guardId: g16, creator: randomUUID(), createdAt: '2026-10-21T09:00:00.000Z', rows: bethel() });
      await q(`INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords)
               VALUES ($1, $2, $3, NOW(), '(0,0)')`, [c8[4], g16, siteC]);
      // C9, C10 CORRECT series (09:00–15:00 at the site every Sunday) that an admin later edited,
      // with the audit row PATCH /:id writes. C9: its FIRST shift moved an hour later, which must
      // not become the reference (it would move Nov 1 to 10:00). C10: Nov 8 moved an hour earlier,
      // exactly what drift looks like, which must not be undone.
      const auditEdit = async (id: string, to: [string, string]) => {
        const was = (await q(`SELECT scheduled_start, scheduled_end FROM shifts WHERE id = $1`, [id])).rows[0];
        await q(`UPDATE shifts SET scheduled_start = $2, scheduled_end = $3 WHERE id = $1`, [id, to[0], to[1]]);
        await q(`INSERT INTO shift_schedule_audit (shift_id, action, changed_by, changed_by_role, reason, before, after)
                 VALUES ($1, 'shift_schedule_edited', $2, 'company_admin', 'harness edit', $3, $4)`,
          [id, randomUUID(), JSON.stringify({ scheduled_start: iso(was.scheduled_start), scheduled_end: iso(was.scheduled_end) }),
           JSON.stringify({ scheduled_start: to[0], scheduled_end: to[1] })]);
      };
      const correct = (extra: string[]): Array<[string, string, string]> => asOld([
        ...['10-04', '10-11', '10-18', '10-25'].map((d): [string, string] => [`2026-${d}T16:00:00.000Z`, `2026-${d}T22:00:00.000Z`]),
        ...extra.map((d): [string, string] => [`2026-${d}T17:00:00.000Z`, `2026-${d}T23:00:00.000Z`]),
      ], 'unassigned', NOW_C);
      const c9 = await seed({ guardId: null, creator: randomUUID(), createdAt: '2026-09-28T10:00:00.000Z', rows: correct(['11-01']) });
      await auditEdit(c9[0], ['2026-10-04T17:00:00.000Z', '2026-10-04T23:00:00.000Z']);
      const c10 = await seed({ guardId: null, creator: randomUUID(), createdAt: '2026-09-28T11:00:00.000Z', rows: correct(['11-01', '11-08']) });
      await auditEdit(c10[5], ['2026-11-08T16:00:00.000Z', '2026-11-08T22:00:00.000Z']);
      // C11 one admin, one site, two series created 1 s apart (one batch), 08:00–16:00 and
      // 09:00–17:00 PDT, Oct 27–30: an hour apart with no DST change between them. Nothing drifted.
      const creatorX = randomUUID();
      const c11a = await seed({ guardId: null, creator: creatorX, createdAt: '2026-10-21T08:00:00.000Z',
        rows: ['27', '28', '29', '30'].map((d): [string, string, string] => [`2026-10-${d}T15:00:00.000Z`, `2026-10-${d}T23:00:00.000Z`, 'unassigned']) });
      const c11b = await seed({ guardId: null, creator: creatorX, createdAt: '2026-10-21T08:00:01.000Z',
        rows: [['27', '28'], ['28', '29'], ['29', '30'], ['30', '31']].map(([d, e]): [string, string, string] => [`2026-10-${d}T16:00:00.000Z`, `2026-10-${e}T00:00:00.000Z`, 'unassigned']) });
      // C12 the old loop's Sundays at 16:00Z from Oct 25, its first two shifts edited by an admin, so
      // the reference is Nov 8, itself an hour early. Only "suspect" is right: nothing to compare with.
      const c12 = await seed({ guardId: null, creator: randomUUID(), createdAt: '2026-10-19T10:00:00.000Z',
        rows: asOld(oldLoopUtc('2026-10-25T16:00:00.000Z', '2026-10-25T22:00:00.000Z', [0], LA), 'unassigned', NOW_C) });
      await auditEdit(c12[0], ['2026-10-25T15:00:00.000Z', '2026-10-25T21:00:00.000Z']);
      await auditEdit(c12[1], ['2026-11-01T17:00:00.000Z', '2026-11-01T23:00:00.000Z']);

      const H = (s: string) => new Date(s);
      const want = new Map<string, [string, string]>([
        [c1[4],    ['2026-11-01T17:00:00.000Z', '2026-11-01T23:00:00.000Z']],
        [day[2],   ['2026-11-01T14:00:00.000Z', '2026-11-02T02:00:00.000Z']],
        [day[3],   ['2026-11-02T14:00:00.000Z', '2026-11-03T02:00:00.000Z']],
        [night[1], ['2026-11-01T01:00:00.000Z', '2026-11-01T14:00:00.000Z']],
        [night[2], ['2026-11-02T02:00:00.000Z', '2026-11-02T14:00:00.000Z']],
        [night[3], ['2026-11-03T02:00:00.000Z', '2026-11-03T14:00:00.000Z']],
        [c3[1],    ['2026-11-01T07:30:00.000Z', '2026-11-01T16:30:00.000Z']],
      ]);
      const wantRefused = new Map<string, RegExp>([
        [c3[2], /not the shift DST made/], [c3[3], /not the shift DST made/], [c3[4], /not the shift DST made/],
        [c6[4], new RegExp(`overlaps shift ${c6block}`)], [c8[4], /has a session/],
        [c10[5], /edited by an admin/],
        ...c11b.map((id): [string, RegExp] => [id, /not the shift DST made/]),
      ]);
      const rRows = Object.values(rIds).flat();

      // The detector first filed under N160, verbatim: blind to C1 once October completed.
      const old = (await q(`SELECT left(s.site_id::text, 8) AS site, left(coalesce(s.guard_id::text, '-'), 8) AS guard,
       to_char(date_trunc('minute', s.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS batch_utc,
       to_char(s.scheduled_start AT TIME ZONE 'UTC', 'HH24:MI') AS utc_start,
       string_agg(DISTINCT to_char(s.scheduled_start AT TIME ZONE si.timezone, 'HH24:MI'), ',') AS local_starts,
       count(*) AS future_shifts
FROM shifts s JOIN sites si ON si.id = s.site_id
WHERE s.status IN ('scheduled', 'unassigned') AND s.scheduled_start > now()
GROUP BY s.site_id, s.guard_id, date_trunc('minute', s.created_at), to_char(s.scheduled_start AT TIME ZONE 'UTC', 'HH24:MI')
HAVING count(DISTINCT to_char(s.scheduled_start AT TIME ZONE si.timezone, 'HH24:MI')) > 1`)).rows;
      check('C.olddetector', !old.some((r: any) => r.guard === g10.slice(0, 8)) && old.some((r: any) => r.guard === g11.slice(0, 8)),
            `the old detector flags C2, still all scheduled, and returns nothing for C1 once October completed (got ${show(old.map((r: any) => r.guard))})`);

      const plan0 = await n160.planCorrections(pool, NOW_C);
      const touched = [...plan0.corrections, ...plan0.refused].map((c: any) => c.id).filter((id: string) => rRows.includes(id));
      check('C.plan.control', touched.length === 0 && sameSet(plan0.suspects.map((s: any) => s.refId), [c4[0], c12[2], rIds.R4?.[0], rIds.R10?.[0]]),
            `series made by the fixed route are never corrected; R4 and R10 (first shift after the change) are suspects with C4 and C12 (touched ${show(touched)}, suspects ${show(plan0.suspects.map((s: any) => s.refId))})`);

      // From here on, only the seeded rows.
      await q(`DELETE FROM shifts WHERE site_id = ANY($1::uuid[])`, [[siteA, siteLon]]);
      const plan = await n160.planCorrections(pool, NOW_C);
      const got = new Map<string, [string, string]>(plan.corrections.map((c: any) => [c.id, [iso(c.newStart), iso(c.newEnd)]]));
      check('C.plan.corrections', got.size === want.size && [...want].every(([id, w]) => show(got.get(id)) === show(w)),
            `exactly the 7 drifted shifts, each to its wall-clock window (got ${show([...got])})`);
      check('C.plan.long', sameSet(plan.corrections.filter((c: any) => c.long).map((c: any) => c.id), [night[1]]),
            `only the Oct 31 night ends up over 12 h (got ${show(plan.corrections.filter((c: any) => c.long).map((c: any) => c.id))})`);
      check('C.plan.refused', plan.refused.length === wantRefused.size
            && plan.refused.every((r: any) => wantRefused.get(r.id)?.test(r.reason)),
            `refused: C3's three re-dated Sundays, C6 (overlap), C8 (session), C10 (an admin's edit), C11's second series (no DST change) (got ${show(plan.refused.map((r: any) => [r.id, r.reason]))})`);
      check('C.plan.suspects', sameSet(plan.suspects.map((s: any) => s.refId), [c4[0], c12[2]]),
            `suspects: C4, and C12 by its first shift (got ${show(plan.suspects.map((s: any) => s.refId))})`);

      const N = plan.corrections.length;
      const auditCount = async () => (await q(`SELECT COUNT(*)::int AS n FROM shift_schedule_audit WHERE reason = $1`, [n160.N160_REASON])).rows[0].n;
      const snapshot = async () => show((await q(`SELECT id, scheduled_start, scheduled_end, expires_at FROM shifts WHERE site_id = $1 ORDER BY id`, [siteC])).rows);
      const before = await snapshot();
      const refusalOf = async (opts: Record<string, unknown>) => {
        try { await n160.applyCorrections({ now: NOW_C, log: () => {}, ...opts }); return null; }
        catch (err) { return err; }
      };
      const e1 = await refusalOf({ expect: N - 1, confirmLong: true });
      check('C.apply.expect', e1 instanceof n160.N160Refusal && (await snapshot()) === before && (await auditCount()) === 0,
            `--expect off by one: refused, nothing written (got ${String(e1)})`);
      const e2 = await refusalOf({ expect: N, confirmLong: false });
      check('C.apply.long', e2 instanceof n160.N160Refusal && /12 hours/.test(String(e2)) && (await snapshot()) === before && (await auditCount()) === 0,
            `a correction over 12 h without --confirm-long: refused, nothing written (got ${String(e2)})`);
      let applied: any[] = [];
      let e3: unknown = null;
      try { applied = await n160.applyCorrections({ expect: N, confirmLong: true, now: NOW_C, log: () => {} }); }
      catch (err) { e3 = err; }
      check('C.apply.ok', !e3 && applied.length === 7, `--expect=${N} --confirm-long: applied 7 (got ${applied.length}${e3 ? ', threw ' + String(e3) : ''})`);

      const rows = new Map<string, any>((await q(`SELECT * FROM shifts WHERE site_id = $1`, [siteC])).rows.map((r: any) => [r.id, r]));
      const seeded = new Map<string, [string, string]>();
      for (const id of [...c1, ...day, ...night, ...c3, ...c4, ...c6, c6block, ...c8, ...c9, ...c10, ...c11a, ...c11b, ...c12]) {
        const r = rows.get(id);
        seeded.set(id, [iso(r?.scheduled_start), iso(r?.scheduled_end)]);
      }
      const stillOld = [...seeded].filter(([id]) => !want.has(id))
        .every(([id, v]) => before.includes(`"id":"${id}","scheduled_start":"${v[0]}","scheduled_end":"${v[1]}"`));
      check('C.rows', [...want].every(([id, w]) => show(seeded.get(id)) === show(w)) && stillOld,
            `the 7 moved to their windows; every other seeded shift untouched`);
      check('C.expires', [...want].every(([id, w]) => ms(rows.get(id)?.expires_at) === retention.expiresAtFor('shift', H(w[0])).getTime()),
            'expires_at follows the new start, as the edit does');
      check('C.latches', rows.get(c1[4])?.pre_shift_reminder_sent_at === null, 'C1 Nov 1: the pre-shift reminder latch is re-armed');
      const audits = (await q(`SELECT shift_id, action, changed_by, changed_by_role, reason, before, after FROM shift_schedule_audit WHERE reason = $1`,
        [n160.N160_REASON])).rows;
      const auditOk = audits.length === 7 && audits.every((a: any) => {
        const w = want.get(a.shift_id);
        const o = before.match(new RegExp(`"id":"${a.shift_id}","scheduled_start":"([^"]+)","scheduled_end":"([^"]+)"`));
        return !!w && !!o && a.action === 'shift_schedule_edited' && a.changed_by === '00000000-0000-0000-0000-000000000000'
          && a.changed_by_role === 'vishnu' && canon(a.after) === canon({ scheduled_start: w[0], scheduled_end: w[1] })
          && canon(a.before) === canon({ scheduled_start: o[1], scheduled_end: o[2] });
      });
      check('C.audit', auditOk, `7 audit rows: shift_schedule_edited, super-admin sub, role vishnu, exact before/after (got ${audits.length})`);
      const notes = (await q(`SELECT guard_id, title, body, data FROM notifications WHERE type = 'shift_schedule_edited' AND guard_id = ANY($1::uuid[])`,
        [[g10, g11, g12, g13, g16]])).rows;
      const t = (d: string) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: LA }).format(new Date(d));
      const dd = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: LA }).format(new Date(d));
      const noteFor = (id: string) => { const w = want.get(id)!; return `Now ${dd(w[0])}, ${t(w[0])} – ${t(w[1])}. Tap to view details.`; };
      const assigned = [c1[4], day[2], day[3], night[1], night[2], night[3]];
      check('C.notif', notes.length === 6 && assigned.every((id) => notes.some((n: any) => n.data?.shift_id === id
              && n.title === `Shift time changed at ${siteCName}` && n.body === noteFor(id)
              && n.data?.scheduled_start === want.get(id)![0] && n.data?.scheduled_end === want.get(id)![1])),
            `one notice per assigned corrected shift (6), the edit's wording; none for the unassigned one (got ${notes.length})`);
      const ps = [...pushFor(g10), ...pushFor(g11)];
      check('C.push', ps.length === 6 && assigned.every((id) => ps.some((p) => p.data?.shift_id === id && p.body === noteFor(id))),
            `6 pushes, same text (got ${ps.length})`);

      const planAfter = await n160.planCorrections(pool, NOW_C);
      let again: any[] | null = null;
      try { again = await n160.applyCorrections({ expect: 0, confirmLong: false, now: NOW_C, log: () => {} }); } catch { again = null; }
      check('C.idem', planAfter.corrections.length === 0 && Array.isArray(again) && again.length === 0 && (await auditCount()) === 7,
            `run again: nothing planned, --expect=0 applies nothing (got ${planAfter.corrections.length} planned, ${show(again?.length)})`);

      // C7 spring: a winter series moving into March; one shift would move into the past.
      const g15 = await mkGuard(siteC);
      const NOW_S = new Date('2027-03-14T16:30:00.000Z');
      const c7 = await seed({ guardId: g15, creator: randomUUID(), createdAt: '2027-02-20T10:00:00.000Z',
        rows: asOld(oldLoopUtc('2027-03-07T17:00:00.000Z', '2027-03-08T01:00:00.000Z', [0], LA), 'scheduled', NOW_S) });
      const spring = await n160.planCorrections(pool, NOW_S);
      const sp = new Map<string, [string, string]>(spring.corrections.map((c: any) => [c.id, [iso(c.newStart), iso(c.newEnd)]]));
      check('C.spring', c7.length === 5 && sp.size === 3
            && show(sp.get(c7[2])) === show(['2027-03-21T16:00:00.000Z', '2027-03-22T00:00:00.000Z'])
            && show(sp.get(c7[3])) === show(['2027-03-28T16:00:00.000Z', '2027-03-29T00:00:00.000Z'])
            && show(sp.get(c7[4])) === show(['2027-04-04T16:00:00.000Z', '2027-04-05T00:00:00.000Z'])
            && n160.direction(spring.corrections) === -1
            && spring.refused.length === 1 && spring.refused[0].id === c7[1] && /in the past/.test(spring.refused[0].reason),
            `spring: Mar 21, Mar 28 and Apr 4 move an hour earlier; Mar 14 would start in the past, refused (got ${show([...sp])} refused ${show(spring.refused.map((r: any) => [r.id, r.reason]))})`);

      const lines: string[] = [];
      const codes = [
        await n160.main(['--apply'], (l: string) => lines.push(l)),
        await n160.main(['--expect=3'], (l: string) => lines.push(l)),
        await n160.main(['--bogus'], (l: string) => lines.push(l)),
      ];
      const snapBefore = await snapshot();
      const auditBefore = await auditCount();
      const dry = await n160.main([], (l: string) => lines.push(l));
      check('C.cli', show(codes) === show([2, 2, 2]) && dry === 0 && (await snapshot()) === snapBefore && (await auditCount()) === auditBefore
            && lines.some((l) => l.startsWith('N160 DST correction: DRY RUN')),
            `usage errors exit 2; the dry run exits 0 and writes nothing (got ${show(codes)}, ${dry})`);
    }
  } finally {
    await sleep(300);                                      // the route's fire-and-forget pushes
    try {
      await q(`TRUNCATE companies, notifications CASCADE`);
    } catch (err) {
      console.log(`  (cleanup incomplete, throwaway database: ${(err as Error).message})`);
    }
    await pool.end();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
