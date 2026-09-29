/**
 * Tests the window on GET /shifts, guard branch (routes/shifts.ts).
 *
 * WHY. The query used to end in a bare
 *   ORDER BY s.scheduled_start DESC LIMIT 50
 * which returns the fifty FURTHEST-FUTURE shifts, not the next fifty. A guard
 * with more rows than the cap therefore lost the PRESENT off the bottom of the
 * payload: their live shift fell past the cut, home.tsx picked the earliest row
 * it could see, and the home screen offered a shift sixteen days out with CLOCK
 * IN disabled. Silent — no error, no empty state, just a confidently wrong
 * date. Observed on a real guard with 98 rows; STARNET's GRD0004 sat at 46/50.
 *
 * The fix moves the LIMIT into an ASCENDING inner query and re-sorts DESCENDING
 * on the way out. Two properties therefore have to hold together, and neither
 * is obvious from reading the SQL:
 *
 *   1. TRUNCATION MUST BITE THE FAR FUTURE, NOT THE PRESENT. Nothing truncates
 *      at LIMIT 200 today, which makes the subquery look like dead weight and
 *      invites a later "simplification" back to a bare DESC LIMIT. The
 *      OVER_CAP case below builds a guard past the cap on purpose and fails if
 *      that happens.
 *   2. THE WIRE ORDER MUST STAY DESCENDING. profile.tsx:85 does
 *      `completedShifts.slice(0, 20)` with NO sort of its own, so it renders
 *      whatever the server sent first. Ascending on the wire turns every
 *      guard's "recent shifts" into their twenty OLDEST, on handsets outside
 *      the current OTA group's reach.
 *
 * The descending assertion is easy to write backwards — it was, on the first
 * attempt during this change's verification, and a backwards assertion reports
 * a defect that is not there (or worse, passes when it should not). So
 * isDescending() states its comparison direction explicitly and is itself
 * checked against an ASCENDING fixture before any real result is trusted. See
 * the SELF-CHECK group.
 *
 * HOW IT RUNS. routes/shifts.ts is an Express router that opens a database pool
 * at import time, so the route cannot be required from a test without the
 * injection harness _pingReminder.test.ts uses. Instead the SQL is EXTRACTED
 * FROM THE SOURCE — the same template literal the route executes, with
 * SHIFT_HOURS_AGG_SQL_FIELDS resolved through the real helper — and run against
 * a throwaway schema on a local Postgres. Extracting rather than retyping is
 * deliberate: a retyped copy proves only that the copy behaves, and would keep
 * passing after someone edited the route.
 *
 * NO LOCAL POSTGRES? The source-contract and self-check groups still run and
 * still catch a reverted subquery, but the semantic groups CANNOT run and the
 * script says so loudly and exits non-zero rather than reporting a clean pass.
 * A green run with no database would be a lie.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/routes/_shiftsListWindow.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SHIFT_HOURS_AGG_SQL_FIELDS } from '../services/shiftHours';

// ── Extract the guard-branch query from the route source ──────────────────
// Walks the template literal by hand so ${...} interpolations survive to be
// resolved below. Anchored on `SELECT * FROM (`, which is the subquery this
// change introduced: if someone collapses it back to a bare SELECT the marker
// is gone and this throws rather than silently testing nothing.

function extractGuardBranchSql(): string {
  const src = readFileSync(join(__dirname, 'shifts.ts'), 'utf8');
  const start = src.indexOf('`SELECT * FROM (');
  assert.ok(
    start >= 0,
    'Could not find the guard-branch query in routes/shifts.ts. It is anchored on ' +
    '"`SELECT * FROM (" — if the subquery was removed, that is the regression ' +
    'this file exists to catch, not a broken test.',
  );
  let depth = 0;
  let out = '';
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { out += src[i] + src[i + 1]; i++; continue; }
    if (c === '$' && src[i + 1] === '{') { depth++; out += '${'; i++; continue; }
    if (c === '}' && depth > 0) { depth--; out += '}'; continue; }
    if (c === '`' && depth === 0) break;
    out += c;
  }
  const sql = out.replace(/\$\{SHIFT_HOURS_AGG_SQL_FIELDS\('ss'\)\}/g, SHIFT_HOURS_AGG_SQL_FIELDS('ss'));
  assert.ok(!sql.includes('${'), `Unresolved interpolation in extracted SQL: ${sql.match(/\$\{[^}]*\}/g)}`);
  return sql;
}

const SQL = extractGuardBranchSql();

/** The pre-fix form, rebuilt from the extracted query by undoing the three
 *  changes. Used only to prove the fixtures below actually reproduce the bug —
 *  a regression test that cannot fail on the old code is not a test. */
function preFixSql(sql: string): string {
  return sql
    .replace(/^SELECT \* FROM \(/, '')
    .replace(/AND s\.scheduled_end > NOW\(\) - INTERVAL '120 days'/, '')
    .replace(/ORDER BY s\.scheduled_start ASC/, 'ORDER BY s.scheduled_start DESC')
    .replace(/\)\s*t\s*ORDER BY t\.scheduled_start DESC\s*$/, '');
}

// ── Order predicate ───────────────────────────────────────────────────────
/**
 * True when `rows` are in DESCENDING order of scheduled_start.
 *
 * DIRECTION, STATED EXPLICITLY BECAUSE IT IS EASY TO INVERT:
 * descending means each row is EARLIER THAN OR EQUAL TO the row before it, so
 * the comparison is `curr <= prev`. Writing `curr >= prev` tests ASCENDING and
 * will report a correct descending result as broken. Ties are allowed — two
 * shifts may share a start instant, and several do in production.
 */
function isDescending(rows: { scheduled_start: Date | string }[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].scheduled_start).getTime();
    const curr = new Date(rows[i].scheduled_start).getTime();
    if (!(curr <= prev)) return false;
  }
  return true;
}

let n = 0;
const ok = (label: string) => { n += 1; console.log(`  ok ${String(n).padStart(2)}  ${label}`); };

console.log('\nGET /shifts — guard branch window\n');

// ── 1. SOURCE CONTRACT (no database needed) ──────────────────────────────
// Structural assertions on the SQL the route actually executes. These are what
// survive when no Postgres is reachable, and they alone catch a reverted
// subquery.
{
  const limits = SQL.match(/LIMIT\s+\d+/gi) ?? [];
  assert.strictEqual(limits.length, 1, `expected exactly one LIMIT, found ${limits.length}: ${limits}`);

  const orders = SQL.match(/ORDER BY[^\n]*/gi) ?? [];
  assert.strictEqual(orders.length, 2, `expected two ORDER BYs (inner ASC, outer DESC), found: ${orders}`);
  assert.ok(/ORDER BY\s+s\.scheduled_start\s+ASC/i.test(orders[0]), `inner ORDER BY must be ASC, got: ${orders[0]}`);
  assert.ok(/ORDER BY\s+t\.scheduled_start\s+DESC/i.test(orders[1]), `outer ORDER BY must be DESC, got: ${orders[1]}`);

  // The LIMIT must sit INSIDE the subquery — i.e. before the closing `) t`.
  const limitAt = SQL.search(/LIMIT\s+\d+/i);
  const closeAt = SQL.search(/\)\s*t\s*$|\)\s*t\s*\n/);
  assert.ok(limitAt >= 0 && closeAt >= 0 && limitAt < closeAt,
    'LIMIT must be inside the subquery; a top-level LIMIT is the original bug');

  assert.ok(/scheduled_end\s*>\s*NOW\(\)\s*-\s*INTERVAL\s*'120 days'/i.test(SQL),
    'the 120-day anchor is missing');

  // Cancelled rows are deliberately RETAINED — schedule.tsx renders them.
  assert.ok(!/status\s*(<>|!=)\s*'cancelled'/i.test(SQL),
    'cancelled rows must NOT be filtered server-side; schedule.tsx:249 renders them');
}
ok('source contract              -> one LIMIT, inside the subquery, inner ASC / outer DESC');

// ── 2. SELF-CHECK: prove the order assertion bites ───────────────────────
// Addition to the brief, and the reason for it: the descending assertion was
// written backwards on the first attempt during verification. An assertion
// that cannot fail is worse than no assertion, so check it both ways against
// known fixtures BEFORE trusting it on a real result.
{
  const d = (s: string) => ({ scheduled_start: s });
  const DESCENDING = [d('2026-03-03T00:00:00Z'), d('2026-02-02T00:00:00Z'), d('2026-01-01T00:00:00Z')];
  const ASCENDING  = [d('2026-01-01T00:00:00Z'), d('2026-02-02T00:00:00Z'), d('2026-03-03T00:00:00Z')];
  const TIED       = [d('2026-02-02T00:00:00Z'), d('2026-02-02T00:00:00Z'), d('2026-01-01T00:00:00Z')];

  assert.strictEqual(isDescending(DESCENDING), true,  'descending fixture must pass');
  assert.strictEqual(isDescending(ASCENDING),  false, 'ASCENDING FIXTURE MUST FAIL — if this passes the assertion is inverted and proves nothing');
  assert.strictEqual(isDescending(TIED),       true,  'equal starts are allowed');
  assert.strictEqual(isDescending([]),         true,  'empty is vacuously ordered');
  assert.strictEqual(isDescending([d('2026-01-01T00:00:00Z')]), true, 'single row is vacuously ordered');
}
ok('order assertion self-check   -> passes descending, FAILS ascending (it bites)');

// ── Database-backed groups ────────────────────────────────────────────────

const PG_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://localhost:5432/postgres';

const SCHEMA = `shiftwin_test_${process.pid}_${Date.now().toString(36)}`;

/** The in-progress shift. Distinct prefix so it is obvious in a failure message. */
const LIVE = '0e1e0e1e-0000-4000-8000-000000000000';
const GUARD_OVER_CAP  = '11111111-1111-4111-8111-111111111111';
const GUARD_CANCELLED = '22222222-2222-4222-8222-222222222222';
const GUARD_NO_FUTURE = '33333333-3333-4333-8333-333333333333';
const GUARD_BOUNDARY  = '44444444-4444-4444-8444-444444444444';
const SITE            = '55555555-5555-4555-8555-555555555555';
const COMPANY         = '66666666-6666-4666-8666-666666666666';

/** Minimal schema — only the tables and columns the extracted query touches. */
const DDL = `
CREATE SCHEMA ${SCHEMA};
SET search_path TO ${SCHEMA};
CREATE TABLE companies (id uuid PRIMARY KEY, default_photo_limit int NOT NULL DEFAULT 5);
CREATE TABLE sites (
  id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles', is_active boolean NOT NULL DEFAULT true,
  instructions_pdf_url text, photo_limit_override int);
CREATE TABLE shifts (
  id uuid PRIMARY KEY, site_id uuid NOT NULL, guard_id uuid,
  scheduled_start timestamptz NOT NULL, scheduled_end timestamptz NOT NULL,
  status varchar(20) NOT NULL);
CREATE TABLE shift_sessions (
  id uuid PRIMARY KEY, shift_id uuid NOT NULL, guard_id uuid NOT NULL,
  clocked_in_at timestamptz, clocked_out_at timestamptz,
  total_hours numeric, ping_interval_minutes int);
CREATE TABLE break_sessions (
  id uuid PRIMARY KEY, shift_session_id uuid NOT NULL,
  break_start timestamptz, break_end timestamptz);
CREATE TABLE geofence_violations (
  id uuid PRIMARY KEY, shift_session_id uuid NOT NULL,
  occurred_at timestamptz, resolved_at timestamptz);
CREATE TABLE location_pings (
  id uuid PRIMARY KEY, shift_session_id uuid NOT NULL, pinged_at timestamptz);
INSERT INTO companies (id) VALUES ('${COMPANY}');
INSERT INTO sites (id, company_id, name) VALUES ('${SITE}', '${COMPANY}', 'Test Site');
`;

function uuidFor(prefix: string, i: number): string {
  const tail = String(i).padStart(12, '0');
  return `${prefix}-0000-4000-8000-${tail}`;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: PG_URL });
  try {
    await client.connect();
  } catch (err) {
    console.log('\n  ✗ NO LOCAL POSTGRES REACHABLE at ' + PG_URL);
    console.log('    ' + (err instanceof Error ? err.message : String(err)));
    console.log('\n  The source-contract and self-check groups above PASSED and do catch a');
    console.log('  reverted subquery. The semantic groups (truncation, ordering, lookback)');
    console.log('  DID NOT RUN. This is not a pass — start Postgres, or set TEST_DATABASE_URL,');
    console.log('  and run it again.\n');
    process.exit(1);
  }

  try {
    await client.query(DDL);
    await client.query(`SET search_path TO ${SCHEMA}`);

    // ── Fixtures ──────────────────────────────────────────────────────────
    // GUARD_OVER_CAP — the GRD0027 shape. 250 rows, comfortably past LIMIT 200,
    // with the LIVE shift early in time so a DESC-first cut would drop it. Day
    // 0 is today; rows run from today forward, exactly like a daily schedule
    // extended far into the future.
    const rows: string[] = [];
    rows.push(
      `('${LIVE}','${SITE}','${GUARD_OVER_CAP}',NOW() - INTERVAL '2 hours',NOW() + INTERVAL '10 hours','scheduled')`,
    );
    for (let i = 1; i <= 249; i++) {
      rows.push(
        `('${uuidFor('11111111', i)}','${SITE}','${GUARD_OVER_CAP}',` +
        `NOW() + INTERVAL '${i} days',NOW() + INTERVAL '${i} days 10 hours','scheduled')`,
      );
    }
    // GUARD_CANCELLED — mostly-cancelled, the reschedule-residue shape.
    rows.push(
      `('${uuidFor('22222222', 1)}','${SITE}','${GUARD_CANCELLED}',NOW() - INTERVAL '1 hour',NOW() + INTERVAL '5 hours','scheduled')`,
    );
    for (let i = 2; i <= 60; i++) {
      rows.push(
        `('${uuidFor('22222222', i)}','${SITE}','${GUARD_CANCELLED}',` +
        `NOW() - INTERVAL '${i} hours',NOW() + INTERVAL '${i} hours','cancelled')`,
      );
    }
    // GUARD_NO_FUTURE — everything already finished.
    for (let i = 1; i <= 5; i++) {
      rows.push(
        `('${uuidFor('33333333', i)}','${SITE}','${GUARD_NO_FUTURE}',` +
        `NOW() - INTERVAL '${i + 1} days',NOW() - INTERVAL '${i} days','completed')`,
      );
    }
    // GUARD_BOUNDARY — one row just inside the 120-day lookback and one just
    // outside it. The anchor is on scheduled_end, so that is what straddles.
    rows.push(
      `('${uuidFor('44444444', 1)}','${SITE}','${GUARD_BOUNDARY}',` +
      `NOW() - INTERVAL '119 days 2 hours',NOW() - INTERVAL '119 days','completed')`,
    );
    rows.push(
      `('${uuidFor('44444444', 2)}','${SITE}','${GUARD_BOUNDARY}',` +
      `NOW() - INTERVAL '121 days 2 hours',NOW() - INTERVAL '121 days','completed')`,
    );
    await client.query(
      `INSERT INTO shifts (id, site_id, guard_id, scheduled_start, scheduled_end, status) VALUES ${rows.join(',')}`,
    );

    const run = async (sql: string, guardId: string) =>
      (await client.query(sql, [guardId])).rows as Array<{
        id: string; status: string; scheduled_start: Date; scheduled_end: Date;
      }>;

    /** What home.tsx:442 would choose from a payload. */
    const clientPick = (payload: Array<{ id: string; status: string; scheduled_start: Date }>) =>
      payload
        .filter((s) => s.status === 'scheduled')
        .sort((a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime())[0] ?? null;

    // ── 3. THE GRD0027 SHAPE ─────────────────────────────────────────────
    {
      const payload = await run(SQL, GUARD_OVER_CAP);
      assert.strictEqual(payload.length, 200, `expected the cap to bind at 200, got ${payload.length}`);
      assert.ok(payload.some((r) => r.id === LIVE), 'THE LIVE SHIFT MUST SURVIVE TRUNCATION — this is the whole bug');
      const pick = clientPick(payload);
      assert.ok(pick, 'client must find a shift to offer');
      assert.strictEqual(pick!.id, LIVE, `client must pick the live shift, picked ${pick!.id}`);

      // And prove the fixture actually reproduces the bug on the old query —
      // otherwise this group could pass against either implementation.
      const old = await run(preFixSql(SQL), GUARD_OVER_CAP);
      assert.ok(!old.some((r) => r.id === LIVE),
        'the PRE-FIX query must DROP the live shift for this fixture, or the fixture does not reproduce the bug');
      const oldPick = clientPick(old);
      assert.ok(oldPick && oldPick.id !== LIVE, 'pre-fix client would have picked the wrong shift');
    }
    ok('over-cap guard (GRD0027)     -> live shift survives; pre-fix query drops it');

    // ── 4. WIRE ORDER IS DESCENDING ──────────────────────────────────────
    {
      for (const g of [GUARD_OVER_CAP, GUARD_CANCELLED, GUARD_NO_FUTURE]) {
        const payload = await run(SQL, g);
        assert.ok(isDescending(payload), `wire order must be DESCENDING for ${g} — profile.tsx:85 slices without sorting`);
      }
      // Belt and braces: the first row must be the latest, the last the earliest.
      const payload = await run(SQL, GUARD_OVER_CAP);
      const starts = payload.map((r) => new Date(r.scheduled_start).getTime());
      assert.strictEqual(starts[0], Math.max(...starts), 'first row must be the latest');
      assert.strictEqual(starts[starts.length - 1], Math.min(...starts), 'last row must be the earliest');
    }
    ok('wire order                   -> DESCENDING, first=latest, last=earliest');

    // ── 5. TRUNCATION BITES THE FAR FUTURE ───────────────────────────────
    {
      const payload = await run(SQL, GUARD_OVER_CAP);
      const maxKept = Math.max(...payload.map((r) => new Date(r.scheduled_start).getTime()));
      const all = (await client.query(
        `SELECT scheduled_start FROM shifts WHERE guard_id = $1`, [GUARD_OVER_CAP],
      )).rows as Array<{ scheduled_start: Date }>;
      const maxAll = Math.max(...all.map((r) => new Date(r.scheduled_start).getTime()));
      assert.ok(maxKept < maxAll, 'the rows dropped must be the FURTHEST-FUTURE ones');
      const minKept = Math.min(...payload.map((r) => new Date(r.scheduled_start).getTime()));
      const minAll = Math.min(...all.map((r) => new Date(r.scheduled_start).getTime()));
      assert.strictEqual(minKept, minAll, 'the earliest row must never be dropped');
    }
    ok('truncation direction         -> drops the far future, never the present');

    // ── 6. MOSTLY-CANCELLED GUARD ────────────────────────────────────────
    {
      const payload = await run(SQL, GUARD_CANCELLED);
      assert.strictEqual(payload.length, 60, 'all 60 rows fit under the cap');
      assert.strictEqual(payload.filter((r) => r.status === 'cancelled').length, 59,
        'cancelled rows must be RETAINED — schedule.tsx renders them');
      const pick = clientPick(payload);
      assert.ok(pick && pick.status === 'scheduled', 'client filters cancelled out itself');
      assert.strictEqual(pick!.id, uuidFor('22222222', 1), 'client must pick the one scheduled shift');
    }
    ok('mostly-cancelled guard       -> cancelled retained, client still picks the live one');

    // ── 7. GUARD WITH NO FUTURE SHIFTS ───────────────────────────────────
    {
      const payload = await run(SQL, GUARD_NO_FUTURE);
      assert.strictEqual(payload.length, 5, 'past shifts are still returned — profile needs them');
      assert.ok(payload.every((r) => new Date(r.scheduled_end).getTime() < Date.now()), 'all in the past');
      const future = payload.filter((r) => r.status === 'scheduled' && new Date(r.scheduled_end).getTime() > Date.now());
      assert.strictEqual(future.length, 0, 'no future shift to offer');
      assert.ok(isDescending(payload), 'ordering holds for a past-only guard');
    }
    ok('guard with no future shifts  -> past rows returned, nothing offered, order holds');

    // ── 8. LOOKBACK BOUNDARY ─────────────────────────────────────────────
    {
      const payload = await run(SQL, GUARD_BOUNDARY);
      const ids = payload.map((r) => r.id);
      assert.ok(ids.includes(uuidFor('44444444', 1)), 'a shift ending 119 days ago must be INSIDE the 120-day window');
      assert.ok(!ids.includes(uuidFor('44444444', 2)), 'a shift ending 121 days ago must be OUTSIDE it');
      assert.strictEqual(payload.length, 1, 'exactly one of the pair survives');
    }
    ok('lookback boundary            -> 119 days in, 121 days out');

    // ── 9. RESPONSE SHAPE UNCHANGED ──────────────────────────────────────
    // The client parses this payload on runtime 1.0.16, outside the current
    // OTA group's reach, so a dropped or renamed field is unshippable.
    {
      const payload = await run(SQL, GUARD_CANCELLED);
      for (const f of [
        'id', 'site_id', 'guard_id', 'scheduled_start', 'scheduled_end', 'status',
        'site_name', 'site_tz', 'site_is_active', 'instructions_pdf_url',
        'effective_photo_limit', 'total_hours_worked',
        'h_scheduled', 'h_actual', 'h_break', 'h_violation',
      ]) {
        assert.ok(f in payload[0], `response field "${f}" is missing — the client parses it`);
      }
      assert.strictEqual(new Set(payload.map((r) => r.id)).size, payload.length,
        'no row multiplication from the joins');
    }
    ok('response shape               -> all 16 client-parsed fields present, no duplicates');

  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }

  console.log(`\nPASS — ${n} groups, all assertions held.\n`);
}

void main().catch((err) => {
  console.error('\nFAIL —', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
