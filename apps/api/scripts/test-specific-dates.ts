/**
 * test-specific-dates.ts — exercises the `mode: 'specific_dates'` branch
 * added to POST /api/shifts. Mirrors test-past-date-rejection.ts in style,
 * but this one drives the live HTTP endpoint because we need to assert
 * transactional behaviour (rollback when one date conflicts).
 *
 * Coverage:
 *   (1) empty dates array              → 422
 *   (2) one past date in array         → 422 (whole request rejected)
 *   (3) duplicate dates                → 422
 *   (4) 61 dates                       → 422 (over max)
 *   (5) happy path 5 dates             → 201 { ids: [5] }, rows persisted
 *   (6) conflict on date 3 of 5        → 422, 0 rows persisted
 *
 * Prereqs:
 *   - apps/api dev server is running on http://localhost:3001
 *   - DATABASE_URL is set (it shares prod via .env; this script seeds
 *     ephemeral fixtures + cleans up after itself)
 *
 * Usage:
 *   railway run npm run script:test-specific-dates    # against prod
 *   npx ts-node apps/api/scripts/test-specific-dates.ts
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { pacificTodayStr } from '../src/services/pacificDate';

const API = process.env.API_URL ?? 'http://localhost:3001';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

let pass = 0;
let fail = 0;
function ok(msg: string)  { console.log(`  ✓ ${msg}`); pass++; }
function bad(msg: string) { console.error(`  ✗ ${msg}`); fail++; process.exitCode = 1; }

function todayPlus(days: number): string {
  const todayPT = pacificTodayStr();
  const [y, m, d] = todayPT.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

async function pickFixtures(): Promise<{ siteId: string; guardId: string; companyId: string; seededAssignmentId: string | null }> {
  const r = await pool.query(
    `SELECT s.id AS site_id, s.company_id, g.id AS guard_id
       FROM sites s
       JOIN guards g ON g.company_id = s.company_id AND g.is_active = true
      LIMIT 1`,
  );
  if (!r.rows[0]) throw new Error('No site/guard available in DB for tests');
  const fix = { siteId: r.rows[0].site_id, guardId: r.rows[0].guard_id, companyId: r.rows[0].company_id };

  // Phase A: shift creation now enforces guard_site_assignments. Ensure
  // an open-ended assignment covers our test (guard, site) pair for the
  // duration of the run. Reuse an existing assignment if one already
  // covers today; otherwise insert a temporary one and clean it up at
  // end-of-test.
  const cover = await pool.query(
    `SELECT id FROM guard_site_assignments
      WHERE guard_id = $1 AND site_id = $2
        AND assigned_from <= CURRENT_DATE
        AND (assigned_until IS NULL OR assigned_until >= CURRENT_DATE)
      LIMIT 1`,
    [fix.guardId, fix.siteId],
  );
  if (cover.rows[0]) return { ...fix, seededAssignmentId: null };

  const seeded = await pool.query(
    `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from, assigned_until)
     VALUES ($1, $2, CURRENT_DATE, NULL)
     RETURNING id`,
    [fix.guardId, fix.siteId],
  );
  return { ...fix, seededAssignmentId: seeded.rows[0].id };
}

function mintToken(companyId: string): string {
  return jwt.sign(
    { sub: '00000000-aaaa-aaaa-aaaa-000000000001', role: 'company_admin', company_id: companyId, jti: 'test-specific-dates' },
    process.env.JWT_SECRET!,
    { expiresIn: '10m' },
  );
}

async function post(token: string, body: any): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API}/api/shifts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function countShifts(guardId: string, dates: string[]): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM shifts
      WHERE guard_id = $1
        AND (scheduled_start AT TIME ZONE 'America/Los_Angeles')::date = ANY($2::date[])`,
    [guardId, dates],
  );
  return r.rows[0].n;
}

async function deleteShiftsByIds(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await pool.query(`DELETE FROM shifts WHERE id = ANY($1::uuid[])`, [ids]);
}

(async function main() {
  console.log('test-specific-dates.ts — POST /api/shifts mode=specific_dates');
  const fixtures = await pickFixtures();
  const token = mintToken(fixtures.companyId);
  const base = { mode: 'specific_dates', site_id: fixtures.siteId, guard_id: fixtures.guardId, start_time: '08:00', end_time: '12:00' };

  // ── (1) empty dates array ─────────────────────────────────────────────
  {
    const r = await post(token, { ...base, dates: [] });
    if (r.status === 422 && /non-empty/i.test(r.body?.error ?? '')) ok('(1) empty dates → 422');
    else bad(`(1) expected 422 non-empty, got ${r.status} ${JSON.stringify(r.body)}`);
  }

  // ── (2) one past date in array ────────────────────────────────────────
  {
    const r = await post(token, { ...base, dates: [todayPlus(1), todayPlus(2), todayPlus(-3)] });
    if (r.status === 422 && /in the past/i.test(r.body?.error ?? '')) ok('(2) past date → 422 "Cannot schedule shifts in the past."');
    else bad(`(2) expected 422 past, got ${r.status} ${JSON.stringify(r.body)}`);
  }

  // ── (3) duplicate dates ───────────────────────────────────────────────
  {
    const d = todayPlus(1);
    const r = await post(token, { ...base, dates: [d, d, todayPlus(2)] });
    if (r.status === 422 && /unique/i.test(r.body?.error ?? '')) ok('(3) duplicate dates → 422');
    else bad(`(3) expected 422 unique, got ${r.status} ${JSON.stringify(r.body)}`);
  }

  // ── (4) 61 dates ──────────────────────────────────────────────────────
  {
    const many = Array.from({ length: 61 }, (_, i) => todayPlus(i + 1));
    const r = await post(token, { ...base, dates: many });
    if (r.status === 422 && /max 60/i.test(r.body?.error ?? '')) ok('(4) 61 dates → 422 "max 60"');
    else bad(`(4) expected 422 over-max, got ${r.status} ${JSON.stringify(r.body)}`);
  }

  // ── (5) happy path 5 dates ────────────────────────────────────────────
  // Pad ahead 90 days to avoid colliding with existing shifts.
  let happyIds: string[] = [];
  {
    const ds = [todayPlus(90), todayPlus(91), todayPlus(92), todayPlus(93), todayPlus(94)];
    const r = await post(token, { ...base, dates: ds, start_time: '02:00', end_time: '03:00' });
    if (r.status !== 201) { bad(`(5) expected 201, got ${r.status} ${JSON.stringify(r.body)}`); }
    else if (!Array.isArray(r.body?.ids) || r.body.ids.length !== 5) {
      bad(`(5) expected 5 ids, got ${JSON.stringify(r.body)}`);
    } else {
      happyIds = r.body.ids;
      const persistedCount = await countShifts(fixtures.guardId, ds);
      if (persistedCount !== 5) bad(`(5) DB shows ${persistedCount} rows, expected 5`);
      else ok('(5) 5 dates → 201 with 5 ids; rows persisted');
    }
  }

  // ── (6) conflict on date 3 of 5 → 0 new rows ──────────────────────────
  {
    // Plant a real shift on date 3 with overlapping time, so the new
    // request's INSERT for that date hits the overlap check.
    const ds = [todayPlus(180), todayPlus(181), todayPlus(182), todayPlus(183), todayPlus(184)];
    const conflictDate = ds[2];
    const plantRes = await pool.query(
      `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
       VALUES (
         $1, $2,
         ($3::date + '04:00'::time) AT TIME ZONE 'America/Los_Angeles',
         ($3::date + '06:00'::time) AT TIME ZONE 'America/Los_Angeles',
         'scheduled'
       ) RETURNING id`,
      [fixtures.guardId, fixtures.siteId, conflictDate],
    );
    const plantedId = plantRes.rows[0].id;

    try {
      const r = await post(token, { ...base, dates: ds, start_time: '05:00', end_time: '07:00' });
      if (r.status !== 422) bad(`(6) expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
      else if (!new RegExp(`Conflict on date ${conflictDate}`).test(r.body?.error ?? '')) {
        bad(`(6) expected Conflict-on-date message naming ${conflictDate}, got ${JSON.stringify(r.body)}`);
      } else {
        // Verify rollback: the only row that should remain among these 5
        // dates is our planted one.
        const persisted = await pool.query(
          `SELECT id FROM shifts
            WHERE guard_id = $1
              AND (scheduled_start AT TIME ZONE 'America/Los_Angeles')::date = ANY($2::date[])
              AND id <> $3`,
          [fixtures.guardId, ds, plantedId],
        );
        if (persisted.rows.length !== 0) bad(`(6) expected 0 new rows, found ${persisted.rows.length}`);
        else ok('(6) conflict on date 3 → 422, rollback, 0 new rows persisted');
      }
    } finally {
      await pool.query(`DELETE FROM shifts WHERE id = $1`, [plantedId]);
    }
  }

  // ── cleanup ─────────────────────────────────────────────────────────
  await deleteShiftsByIds(happyIds);
  if (fixtures.seededAssignmentId) {
    await pool.query(`DELETE FROM guard_site_assignments WHERE id = $1`, [fixtures.seededAssignmentId]);
  }
  await pool.end();

  console.log(`\n  pass=${pass}  fail=${fail}`);
  if (fail === 0) console.log('✓ test-specific-dates PASSED');
  else            console.error('✗ test-specific-dates FAILED');
})().catch((err) => {
  console.error('test-specific-dates error:', err);
  process.exit(1);
});
