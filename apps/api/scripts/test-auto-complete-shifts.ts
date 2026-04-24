/**
 * test-auto-complete-shifts.ts — exercises CB1 fix end-to-end against
 * the live DB.  Same self-cleaning ephemeral-fixture pattern used by
 * seed-retention-test.ts; never modifies real shifts.
 *
 * Test plan:
 *   1. Insert a fake shift whose scheduled_end is 5 min ago and status =
 *      'active', plus an open shift_session (clocked_out_at IS NULL).
 *   2. Insert one closed break (15 min) and one open break inside that
 *      session.
 *   3. Call autoCompleteOverdueShifts(client) directly.
 *   4. Assert:
 *        a. shift status flipped to 'completed'
 *        b. shift_session.clocked_out_at is set
 *        c. shift_session.total_hours > 0 (was the bug — used to be NULL)
 *        d. open break got break_end + duration_minutes
 *        e. Math: total_hours == gross - 15 min (closed break) -
 *           ~0 min (open break, since we just closed it)
 *   5. Cleanup or leave with --keep.
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-auto-complete-shifts.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md, C1)
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { autoCompleteOverdueShifts } from '../src/jobs/autoCompleteShifts';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function pickIds() {
  const c = await pool.query('SELECT id FROM companies LIMIT 1');
  if (!c.rows[0]) throw new Error('No company found');
  const s = await pool.query('SELECT id FROM sites WHERE company_id = $1 LIMIT 1', [c.rows[0].id]);
  if (!s.rows[0]) throw new Error('No site found for that company');
  const g = await pool.query('SELECT id FROM guards WHERE company_id = $1 LIMIT 1', [c.rows[0].id]);
  if (!g.rows[0]) throw new Error('No guard found for that company');
  return { siteId: s.rows[0].id as string, guardId: g.rows[0].id as string };
}

async function run() {
  const { siteId, guardId } = await pickIds();
  console.log(`\n=== test-auto-complete-shifts — site ${siteId.slice(0,8)}, guard ${guardId.slice(0,8)} ===\n`);

  // ---- Seed an overdue shift, an open session, and two breaks ----
  const shift = await pool.query(
    `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
     VALUES ($1, $2,
       NOW() - INTERVAL '4 hours',
       NOW() - INTERVAL '5 minutes',     -- already past
       'active')
     RETURNING id`,
    [siteId, guardId],
  );
  const shiftId = shift.rows[0].id as string;

  const session = await pool.query(
    `INSERT INTO shift_sessions
       (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords)
     VALUES ($1, $2, $3, NOW() - INTERVAL '4 hours', '0,0')
     RETURNING id`,
    [shiftId, guardId, siteId],
  );
  const sessionId = session.rows[0].id as string;

  // Closed 15-minute break
  await pool.query(
    `INSERT INTO break_sessions
       (shift_session_id, guard_id, site_id, break_start, break_end, duration_minutes, break_type)
     VALUES ($1, $2, $3,
       NOW() - INTERVAL '2 hours',
       NOW() - INTERVAL '1 hour 45 minutes',
       15, 'meal')`,
    [sessionId, guardId, siteId],
  );
  // Open break (started 30 sec ago — short, just so duration_minutes ≈ 0)
  await pool.query(
    `INSERT INTO break_sessions
       (shift_session_id, guard_id, site_id, break_start, break_type)
     VALUES ($1, $2, $3, NOW() - INTERVAL '30 seconds', 'rest')`,
    [sessionId, guardId, siteId],
  );

  console.log(`Seeded shift ${shiftId.slice(0,8)} + session ${sessionId.slice(0,8)} + 2 breaks\n`);

  try {
    // ---- Run the worker -------------------------------------------
    const client = await pool.connect();
    let result;
    try {
      result = await autoCompleteOverdueShifts(client);
    } finally {
      client.release();
    }
    console.log(`autoCompleteOverdueShifts returned: ${JSON.stringify(result)}\n`);

    assert(result.shiftsClosed   >= 1, `shiftsClosed >= 1 (got ${result.shiftsClosed})`);
    assert(result.sessionsClosed >= 1, `sessionsClosed >= 1 (got ${result.sessionsClosed})`);
    assert(result.breaksClosed   >= 1, `breaksClosed >= 1 (got ${result.breaksClosed})`);

    // ---- Verify side effects --------------------------------------
    const s = await pool.query('SELECT status FROM shifts WHERE id = $1', [shiftId]);
    assert(s.rows[0].status === 'completed', "shifts.status flipped to 'completed'");

    const ss = await pool.query(
      'SELECT clocked_out_at, total_hours FROM shift_sessions WHERE id = $1', [sessionId]);
    assert(ss.rows[0].clocked_out_at !== null, 'shift_sessions.clocked_out_at set');
    assert(ss.rows[0].total_hours !== null,    'shift_sessions.total_hours set (CB1 fix)');
    assert(ss.rows[0].total_hours > 0,         `total_hours > 0 (got ${ss.rows[0].total_hours})`);

    // gross = ~4h, minus 15-min closed break, minus ≈0-min open break
    // expected total_hours ≈ 3.75 h, allow a wide tolerance for clock skew
    const th = ss.rows[0].total_hours as number;
    assert(Math.abs(th - 3.75) < 0.05,
      `total_hours within 0.05 of 3.75 (got ${th.toFixed(4)})`);

    const bs = await pool.query(
      `SELECT id, break_end, duration_minutes
         FROM break_sessions WHERE shift_session_id = $1 ORDER BY break_start`,
      [sessionId]);
    assert(bs.rows[0].break_end !== null && bs.rows[0].duration_minutes === 15,
      'first break unchanged (still closed, 15 min)');
    assert(bs.rows[1].break_end !== null,
      'second break got break_end set (was NULL before)');
    assert(bs.rows[1].duration_minutes !== null,
      'second break got duration_minutes set');

    // ---- Verify the CHECK constraint blocks negative writes -------
    let checkBlocked = false;
    try {
      await pool.query(
        'UPDATE shift_sessions SET total_hours = -1 WHERE id = $1', [sessionId]);
    } catch (err: any) {
      checkBlocked = err.code === '23514';   // check_violation
    }
    assert(checkBlocked, 'chk_total_hours_nonneg blocks negative total_hours');

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    if (!process.argv.includes('--keep')) {
      await pool.query('DELETE FROM break_sessions WHERE shift_session_id = $1', [sessionId]);
      await pool.query('DELETE FROM shift_sessions WHERE id = $1', [sessionId]);
      await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
      console.log(`Cleaned up shift ${shiftId.slice(0,8)} + session + breaks.`);
    } else {
      console.log(`Left shift ${shiftId} in place (--keep).`);
    }
    await pool.end();
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  pool.end().finally(() => process.exit(1));
});
