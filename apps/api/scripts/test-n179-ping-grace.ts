/**
 * test-n179-ping-grace.ts — the 30-second grace after a ping window closes (N179; Vishnu's decision (a)).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n179-ping-grace.ts     (from apps/api)
 *
 * missedPingCron's and pingReminder's real tick functions, on a local database, run at chosen instants around a
 * cutover C: services/pingGrace.ts's PING_GRACE_FROM, set here two days back. Each case is its own guard, shift and
 * session; every shift runs [C - 2 h, C + 2 h) in 30-minute windows (W-4 .. W3, W0 opening at C). Pings are written
 * into location_pings at their arrival times, in time order with the ticks, so no tick sees a ping from its future.
 * Firebase is a recorder, Sentry is stubbed, and the jobs are not scheduled: runJob only records them.
 *
 *   G  a ping labelled W0 arriving 15 s after W0 closes answers W0 on time: no row, and the ping is not late
 *   X  decision (a): that ping does not also answer W1, which is flagged and pushed
 *   N  a ping labelled W1 arriving in W0's grace answers W1, and W0 is flagged
 *   U  a ping with no label in W1's first seconds still answers W1
 *   F  the control: a ping inside W0 answers it
 *   J  W0 is judged only once its grace has passed: no row at +20 s; the row, its notification and push at +31 s
 *   L  an answer that arrived after the grace but before the tick: the row is written resolved by it, at its
 *      arrival, the ping is marked late, and nobody is notified or pushed
 *   P  before the cutover, the old rule: a +15 s answer is late (resolved at the flag, no push), and it still
 *      answers the window it arrived in
 *   R  the reminder: W0's grace ping no longer silences W1's prompt; before the cutover it still silences it
 *   S  missedPingCron registers at second 31 of every fifth minute, 300 s apart for /health/crons
 *   M  mutation controls: no exclusion (flag and reminder); no grace answer; judged before the grace; no
 *      resolution at the flag; the cutover ignored; the old schedule
 *
 * LOCAL DATABASES ONLY; fake rows under a marker, removed at the end.
 */
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const API = path.join(__dirname, '..');
const GRACE = 'src/services/pingGrace.ts';
const CRON = 'src/jobs/missedPingCron.ts';
const REMINDER = 'src/jobs/pingReminder.ts';
const RUN = 'src/jobs/_run.ts';
const TZ = 'America/Los_Angeles';
const MIN = 60_000;
const SEC = 1000;

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  if (process.env.DATABASE_URL) { console.error('REFUSING: DATABASE_URL is set.'); process.exit(2); }
}
function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}
/** Compile `src` as the module at `rel` and put it in the require cache, so whatever requires that path gets it. */
function register(rel: string, src: string): any {
  const file = path.join(API, rel);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  require.cache[file] = m;
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}
const read = (rel: string) => fs.readFileSync(path.join(API, rel), 'utf8');
function once(s: string, from: string, to: string): string {
  if (s.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from.slice(0, 60))}`);
  return s.replace(from, to);
}

let failures = 0;
let passes = 0;
let finished = false;
process.on('beforeExit', () => { if (!finished) { console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)'); process.exitCode = 1; } });
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const show = (faults: string[]) => (faults.length ? ` [${faults.join('; ')}]` : '');

type CaseKind = 'A' | 'B' | 'U' | 'F' | 'D' | 'L' | 'P' | 'R1' | 'R2';
interface Case { kind: CaseKind; guard: string; token: string; session: string }

async function main(): Promise<void> {
  refuseUnlessLocal();
  const pushes: Array<{ token: string; data: Record<string, string> }> = [];
  inject('../src/services/sentry', {
    Sentry: { captureException: () => 'evt', captureMessage: () => 'evt', addBreadcrumb: () => undefined, getCurrentScope: () => ({ setTag: () => undefined }) },
    tagRequest: () => undefined,
  });
  inject('../src/services/firebase', new Proxy({ __esModule: true }, {
    get: (target, prop) => {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      if (prop === 'sendPushNotification') return async (p: { token: string; data: Record<string, string> }) => { pushes.push({ token: p.token, data: p.data }); };
      return () => undefined;
    },
  }));
  // The real runner, minus the scheduling: runJob records each job's name and expression.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const realRun = require(path.join(API, RUN));
  const jobs: Array<{ name: string; expr: string }> = [];
  inject(path.join(API, RUN), { ...realRun, runJob: (name: string, expr: string) => { jobs.push({ name, expr }); return { stop: () => undefined }; } });

  const pool = ((await import('../src/db/pool')) as any).pool;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const { siteLocalLabel } = await import('../src/services/pingWindows');

  // C: an hour boundary two days back, so every shift has started by the database's clock.
  const C = new Date((await q(`SELECT date_trunc('hour', NOW() - INTERVAL '2 days') AS c`)).rows[0].c);
  const at = (ms: number) => new Date(C.getTime() + ms);
  const W = (k: number) => ({ start: at(k * 30 * MIN), end: at((k + 1) * 30 * MIN) });
  const label = (k: number) => siteLocalLabel(W(k).start, TZ);
  const graceSrc = once(read(GRACE), "new Date('2026-10-16T07:00:00Z')", `new Date('${C.toISOString()}')`);

  function loadJobs(overrides: { grace?: string; cron?: string; reminder?: string } = {}): { cron: any; rem: any } {
    for (const rel of [GRACE, CRON, REMINDER]) delete require.cache[path.join(API, rel)];
    register(GRACE, overrides.grace ?? graceSrc);
    const cron = overrides.cron ? register(CRON, overrides.cron) : require(path.join(API, CRON));
    const rem = overrides.reminder ? register(REMINDER, overrides.reminder) : require(path.join(API, REMINDER));
    return { cron, rem };
  }

  const marker = `lhn179-${Date.now().toString(36)}`;
  const sweep = [
    "DELETE FROM notifications WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn179-%')",
    "DELETE FROM missed_pings WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn179-%')",
    "DELETE FROM location_pings WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn179-%')",
    "DELETE FROM shift_sessions WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn179-%')",
    "DELETE FROM shifts WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn179-%')",
    "DELETE FROM guard_devices WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn179-%')",
    "DELETE FROM guard_site_assignments WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn179-%')",
    "DELETE FROM guards WHERE email LIKE 'lhn179-%'",
    "DELETE FROM sites WHERE name LIKE 'lhn179-%'",
    "DELETE FROM companies WHERE name LIKE 'lhn179-%'",
  ];
  let swept = 0;
  for (const sql of sweep) swept += (await q(sql)).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const foreign = (await q(`SELECT count(*)::int AS n FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id
                             WHERE ss.clocked_out_at IS NULL AND g.email NOT LIKE 'lhn179-%'`)).rows[0].n;
  if (foreign > 0) console.log(`(note: ${foreign} open sessions from elsewhere in this database; the ticks visit them too, and no check reads them)`);

  const companyId = (await q('INSERT INTO companies (name) VALUES ($1) RETURNING id', [marker])).rows[0].id;
  const siteId = (await q(`INSERT INTO sites (company_id, name, address, timezone, contract_start) VALUES ($1, $2, 'addr', $3, CURRENT_DATE - 30) RETURNING id`,
    [companyId, `${marker} site`, TZ])).rows[0].id;
  let made = 0;
  async function mkCase(kind: CaseKind): Promise<Case> {
    made += 1;
    const guard = (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
      [companyId, `${marker} ${kind}${made}`, `${marker}-${kind.toLowerCase()}${made}@test.invalid`, `N179T${made}`])).rows[0].id;
    const token = `ExponentPushToken[${marker}-${made}]`;
    await q('INSERT INTO guard_devices (guard_id, push_token, last_seen_at) VALUES ($1, $2, NOW())', [guard, token]);
    await q('INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) VALUES ($1, $2, CURRENT_DATE - 30)', [guard, siteId]);
    const shift = (await q(`INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, source, expires_at)
                            VALUES ($1, $2, $3, $4, 'active', 'manual', NOW() + INTERVAL '5 years') RETURNING id`,
      [guard, siteId, at(-120 * MIN), at(120 * MIN)])).rows[0].id;
    const session = (await q(`INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords, ping_interval_minutes)
                              VALUES ($1, $2, $3, $4, '(0,0)', 30) RETURNING id`,
      [shift, guard, siteId, at(-125 * MIN)])).rows[0].id;
    return { kind, guard, token, session };
  }
  async function ping(c: Case, arrival: Date, lbl: string | null): Promise<string> {
    return (await q(`INSERT INTO location_pings (shift_session_id, guard_id, site_id, latitude, longitude, is_within_geofence, ping_type,
                       photo_delete_at, pinged_at, window_label, submitted_late)
                     VALUES ($1, $2, $3, 37.33, -121.89, true, 'gps_only', NOW() + INTERVAL '30 days', $4, $5, false) RETURNING id`,
      [c.session, c.guard, siteId, arrival, lbl])).rows[0].id;
  }
  const row = async (c: Case, k: number) => (await q(`SELECT id, resolved_at, resolved_by_ping_id FROM missed_pings
                                                       WHERE shift_session_id = $1 AND window_start = $2`, [c.session, W(k).start])).rows[0] ?? null;
  const missedNotes = async (c: Case, k: number) => (await q(`SELECT count(*)::int AS n FROM notifications
                                                               WHERE guard_id = $1 AND type = 'missed_ping' AND data->>'windowStart' = $2`,
    [c.guard, W(k).start.toISOString()])).rows[0].n as number;
  const reminderNotes = async (c: Case, k: number) => (await q(`SELECT count(*)::int AS n FROM notifications
                                                                 WHERE guard_id = $1 AND type = 'ping_reminder' AND data->>'window_label' = $2`,
    [c.guard, label(k)])).rows[0].n as number;
  const missedPushes = (c: Case, k: number) => pushes.filter((p) => p.token === c.token && p.data?.type === 'missed_ping' && p.data?.windowStart === W(k).start.toISOString()).length;
  const late = async (pingId: string) => (await q('SELECT submitted_late FROM location_pings WHERE id = $1', [pingId])).rows[0]?.submitted_late as boolean;
  async function closeAll(): Promise<void> {
    await q(`UPDATE shift_sessions SET clocked_out_at = $2
              WHERE clocked_out_at IS NULL AND guard_id IN (SELECT id FROM guards WHERE email LIKE $1)`, [`${marker}-%`, at(125 * MIN)]);
  }

  /** Events in time order: a ping is written just before the first tick at or after its arrival. */
  type Ev = { t: Date; run: () => Promise<void> };
  async function play(events: Ev[]): Promise<void> {
    for (const e of [...events].sort((a, b) => a.t.getTime() - b.t.getTime())) await e.run();
  }
  const pingEv = (c: Case, t: Date, lbl: string | null, keep?: (id: string) => void): Ev => ({ t, run: async () => { const id = await ping(c, t, lbl); keep?.(id); } });
  const cronEv = (jobsNow: { cron: any }, t: Date): Ev => ({ t, run: () => jobsNow.cron.missedPingTick(t) });
  const remEv = (jobsNow: { rem: any }, t: Date): Ev => ({ t, run: () => jobsNow.rem.pingReminderTick(t) });

  // ── What each case must show; [] when right ─────────────────────────────────
  const ids: Record<string, string> = {};
  async function faultsA(c: Case): Promise<string[]> {
    const f: string[] = [];
    if (await row(c, 0)) f.push('W0 was flagged');
    if (ids[`ping:${c.session}`] && (await late(ids[`ping:${c.session}`]))) f.push('the grace ping is marked late');
    const r1 = await row(c, 1);
    if (!r1 || r1.resolved_at) f.push(`W1 ${r1 ? 'resolved' : 'not flagged'}`);
    if ((await missedNotes(c, 1)) !== 1 || missedPushes(c, 1) !== 1) f.push(`W1: ${await missedNotes(c, 1)} notifications, ${missedPushes(c, 1)} pushes`);
    return f;
  }
  async function faultsB(c: Case): Promise<string[]> {
    const f: string[] = [];
    if (!(await row(c, 0))) f.push('W0 not flagged');
    if (await row(c, 1)) f.push('W1 flagged');
    return f;
  }
  const faultsNoRow = (k: number) => async (c: Case): Promise<string[]> => ((await row(c, k)) ? [`W${k} flagged`] : []);
  async function faultsL(c: Case): Promise<string[]> {
    const f: string[] = [];
    const r = await row(c, 2);
    const p = ids[`ping:${c.session}`];
    const pAt = p ? (await q('SELECT pinged_at FROM location_pings WHERE id = $1', [p])).rows[0].pinged_at : null;
    if (!r) f.push('W2 not flagged');
    else if (r.resolved_by_ping_id !== p || !r.resolved_at || new Date(r.resolved_at).getTime() !== new Date(pAt).getTime()) f.push('W2 not resolved by the late answer at its arrival');
    if (p && !(await late(p))) f.push('the late answer is not marked late');
    if ((await missedNotes(c, 2)) !== 0 || missedPushes(c, 2) !== 0) f.push(`W2: ${await missedNotes(c, 2)} notifications, ${missedPushes(c, 2)} pushes`);
    return f;
  }
  async function faultsP(c: Case): Promise<string[]> {
    const f: string[] = [];
    const r = await row(c, -3);
    const p = ids[`ping:${c.session}`];
    if (!r || r.resolved_by_ping_id !== p) f.push(`W-3 ${r ? 'not resolved by the +15 s answer' : 'not flagged'}`);
    if (p && !(await late(p))) f.push('the +15 s answer is not marked late');
    if ((await missedNotes(c, -3)) !== 0 || missedPushes(c, -3) !== 0) f.push('W-3 was notified or pushed');
    if (await row(c, -2)) f.push('W-2 flagged: the answer no longer counts for the window it arrived in');
    return f;
  }
  const faultsR1 = async (c: Case): Promise<string[]> => ((await reminderNotes(c, 1)) === 1 ? [] : [`W1 prompts: ${await reminderNotes(c, 1)}`]);
  const faultsR2 = async (c: Case): Promise<string[]> => ((await reminderNotes(c, -2)) === 0 ? [] : [`W-2 prompts: ${await reminderNotes(c, -2)}`]);

  try {
    // ════════════════════════════════════════════════════════════════════════
    const live = loadJobs();
    const cs: Record<CaseKind, Case> = {} as Record<CaseKind, Case>;
    for (const k of ['A', 'B', 'U', 'F', 'D', 'L', 'P', 'R1', 'R2'] as CaseKind[]) cs[k] = await mkCase(k);
    let dEarly: string[] = ['not probed'];
    await play([
      pingEv(cs.P, at(-60 * MIN + 15 * SEC), label(-3), (id) => { ids[`ping:${cs.P.session}`] = id; }),
      pingEv(cs.R2, at(-60 * MIN + 15 * SEC), label(-3)),
      cronEv(live, at(-60 * MIN + 31 * SEC)),
      remEv(live, at(-60 * MIN + 60 * SEC)),
      cronEv(live, at(-30 * MIN + 31 * SEC)),
      pingEv(cs.F, at(10 * MIN), label(0)),
      pingEv(cs.U, at(30 * MIN + 10 * SEC), null),
      pingEv(cs.A, at(30 * MIN + 15 * SEC), label(0), (id) => { ids[`ping:${cs.A.session}`] = id; }),
      pingEv(cs.B, at(30 * MIN + 15 * SEC), label(1)),
      pingEv(cs.R1, at(30 * MIN + 15 * SEC), label(0)),
      cronEv(live, at(30 * MIN + 20 * SEC)),
      { t: at(30 * MIN + 25 * SEC), run: async () => { dEarly = (await row(cs.D, 0)) ? ['W0 flagged at +20 s'] : []; } },
      cronEv(live, at(30 * MIN + 31 * SEC)),
      remEv(live, at(30 * MIN + 60 * SEC)),
      cronEv(live, at(60 * MIN + 31 * SEC)),
      pingEv(cs.L, at(90 * MIN + 35 * SEC), label(2), (id) => { ids[`ping:${cs.L.session}`] = id; }),
      cronEv(live, at(90 * MIN + 40 * SEC)),
    ]);

    section('G, X  the grace, and decision (a)');
    const a = await faultsA(cs.A);
    check(a.length === 0, `a ping labelled W0 at W0's close + 15 s: W0 not flagged and the ping not late; W1, which it alone arrived in, flagged at +31 s with one notification and one push${show(a)}`);

    section('N, U, F  which window a ping answers');
    const b = await faultsB(cs.B);
    check(b.length === 0, `a ping labelled W1 at W0's close + 15 s answers W1; W0 is flagged${show(b)}`);
    const u = await faultsNoRow(1)(cs.U);
    check(u.length === 0, `a ping with no label at W1's open + 10 s answers W1${show(u)}`);
    const fz = await faultsNoRow(0)(cs.F);
    check(fz.length === 0, `the control: a ping inside W0 answers it${show(fz)}`);

    section('J  judged only after the grace');
    const dLate = (await row(cs.D, 0)) && (await missedNotes(cs.D, 0)) === 1 && missedPushes(cs.D, 0) === 1 ? [] : ['W0 not flagged, notified and pushed at +31 s'];
    check(dEarly.length === 0 && dLate.length === 0, `no pings at all: nothing at W0's close + 20 s; the row, one notification and one push at + 31 s${show([...dEarly, ...dLate])}`);

    section('L  an answer that beat the flag');
    const l = await faultsL(cs.L);
    check(l.length === 0, `a ping labelled W2 at W2's close + 35 s, before a tick at + 40 s: the row written resolved by it, at its arrival; the ping marked late; no notification, no push${show(l)}`);

    section('P  before the cutover, the old rule');
    const pz = await faultsP(cs.P);
    check(pz.length === 0, `a ping labelled W-3 at W-3's close + 15 s: W-3 flagged and resolved by it as late, with no push; W-2, which it arrived in, not flagged${show(pz)}`);

    section('R  the reminder');
    const r1 = await faultsR1(cs.R1);
    check(r1.length === 0, `W0's grace ping does not silence W1's prompt: one ping_reminder for W1${show(r1)}`);
    const r2 = await faultsR2(cs.R2);
    check(r2.length === 0, `before the cutover, W-3's late ping still silences W-2's prompt${show(r2)}`);

    section('S  the schedule');
    const mp = jobs.find((j) => j.name === 'missedPingCron');
    check(mp?.expr === '31 */5 * * * *' && realRun.cronIntervalSeconds(mp.expr) === 300,
      `missedPingCron registers at ${JSON.stringify(mp?.expr)}: second 31 of every fifth minute, ${mp ? realRun.cronIntervalSeconds(mp.expr) : '?'} s apart for /health/crons`);
    check(!/anyPingInWindow\(/.test(read(CRON)) && !/async function anyPingInWindow/.test(read(REMINDER))
      && /windowAnsweredOnTime\(/.test(read(CRON)) && /windowAnsweredOnTime\(/.test(read(REMINDER)),
      'both jobs judge "answered" through services/pingGrace.ts; neither keeps its own copy');
    await closeAll();

    section('M  mutation controls (each must fail its case)');
    {
      const NOT_CLAUSE = "                   AND NOT ($4::int > 0\n";
      const noExclusion = once(graceSrc, NOT_CLAUSE, "                   AND NOT ($4::int < 0\n");
      const noGraceAnswer = once(graceSrc, "               OR ($6::int > 0\n", "               OR ($6::int < 0\n");
      const judgedEarly = once(graceSrc, 'return now.getTime() >= windowEnd.getTime() + graceMsFor(windowEnd);', 'return now.getTime() >= windowEnd.getTime();');
      const noCutover = once(graceSrc, 'return windowEnd.getTime() >= PING_GRACE_FROM.getTime() ? PING_GRACE_MS : 0;', 'return PING_GRACE_MS;');
      const noResolve = once(read(CRON), '        if (lateAnswer) {\n          await resolveAtFlag(mpId, lateAnswer);\n          continue;\n        }\n', '');
      const oldSchedule = once(read(CRON), "'31 */5 * * * *'", "'*/5 * * * *'");

      const runA = async (j: { cron: any; rem: any }) => {
        const c = await mkCase('A');
        await play([pingEv(c, at(30 * MIN + 15 * SEC), label(0), (id) => { ids[`ping:${c.session}`] = id; }), cronEv(j, at(30 * MIN + 31 * SEC)), cronEv(j, at(60 * MIN + 31 * SEC))]);
        const f = await faultsA(c); await closeAll(); return f;
      };
      const runR1 = async (j: { cron: any; rem: any }) => {
        const c = await mkCase('R1');
        await play([pingEv(c, at(30 * MIN + 15 * SEC), label(0)), remEv(j, at(30 * MIN + 60 * SEC))]);
        const f = await faultsR1(c); await closeAll(); return f;
      };
      const runD = async (j: { cron: any; rem: any }) => {
        const c = await mkCase('D');
        await play([cronEv(j, at(30 * MIN + 20 * SEC))]);
        const f = (await row(c, 0)) ? ['W0 flagged at +20 s'] : []; await closeAll(); return f;
      };
      const runL = async (j: { cron: any; rem: any }) => {
        const c = await mkCase('L');
        await play([pingEv(c, at(90 * MIN + 35 * SEC), label(2), (id) => { ids[`ping:${c.session}`] = id; }), cronEv(j, at(90 * MIN + 40 * SEC))]);
        const f = await faultsL(c); await closeAll(); return f;
      };
      const runP = async (j: { cron: any; rem: any }) => {
        const c = await mkCase('P');
        await play([pingEv(c, at(-60 * MIN + 15 * SEC), label(-3), (id) => { ids[`ping:${c.session}`] = id; }), cronEv(j, at(-60 * MIN + 31 * SEC)), cronEv(j, at(-30 * MIN + 31 * SEC))]);
        const f = await faultsP(c); await closeAll(); return f;
      };
      const mutants: Array<[string, { grace?: string; cron?: string; reminder?: string }, (j: { cron: any; rem: any }) => Promise<string[]>]> = [
        ['no exclusion: the grace ping also answers W1 (X)', { grace: noExclusion }, runA],
        ['no exclusion, on the reminder: W1\'s prompt silenced (R)', { grace: noExclusion }, runR1],
        ['no grace answer: W0 flagged (G)', { grace: noGraceAnswer }, runA],
        ['judged before the grace (J)', { grace: judgedEarly }, runD],
        ['no resolution at the flag (L)', { cron: noResolve }, runL],
        ['the cutover ignored: the grace before it too (P)', { grace: noCutover }, runP],
      ];
      for (const [labelText, overrides, run] of mutants) {
        const f = await run(loadJobs(overrides));
        check(f.length > 0, `${labelText}: caught${show(f.slice(0, 2))}`);
      }
      jobs.length = 0;
      loadJobs({ cron: oldSchedule });
      const old = jobs.find((j) => j.name === 'missedPingCron');
      check(old?.expr !== '31 */5 * * * *', `the old schedule: caught (missedPingCron registers at ${JSON.stringify(old?.expr)})`);
      loadJobs();
    }
  } finally {
    await closeAll().catch(() => undefined);
    for (const sql of sweep) await q(sql);
    const left = (await q(`SELECT count(*)::int AS n FROM guards WHERE email LIKE 'lhn179-%'`)).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    await pool.end();
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { finished = true; console.error(e); process.exitCode = 1; });
