/**
 * test-concurrent-clock-in.ts — proves CB2/CB3 concurrency fix
 * (audit/WEEK1.md C2) against the live DB.
 *
 * Simulates two devices trying to clock the same guard in at the exact
 * same moment.  With the old code both INSERTs succeeded, producing two
 * open shift_sessions for one guard.  With the new code the partial
 * unique index `idx_shift_sessions_one_open_per_guard` makes exactly one
 * of the two INSERTs raise 23505.
 *
 * This script does NOT call the HTTP endpoint; it calls the INSERT
 * directly via two separate pool connections so we can fire them in
 * parallel.  That isolates the concurrency guarantee provided by the
 * index itself (independent of Express routing or FOR UPDATE).
 *
 * Self-cleans: deletes the ephemeral shift/session rows on exit.
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-concurrent-clock-in.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md, C2)
 */
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function pickIds() {
  const g = await pool.query('SELECT id, company_id FROM guards LIMIT 1');
  if (!g.rows[0]) throw new Error('No guard found');
  const s = await pool.query('SELECT id FROM sites WHERE company_id = $1 LIMIT 1', [g.rows[0].company_id]);
  if (!s.rows[0]) throw new Error('No site found');
  return { guardId: g.rows[0].id as string, siteId: s.rows[0].id as string };
}

async function run() {
  const { guardId, siteId } = await pickIds();
  console.log(`\n=== test-concurrent-clock-in — guard ${guardId.slice(0,8)}, site ${siteId.slice(0,8)} ===\n`);

  // Seed an ephemeral shift to attach the sessions to
  const shift = await pool.query(
    `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
     VALUES ($1, $2, NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '4 hours', 'scheduled')
     RETURNING id`,
    [siteId, guardId]);
  const shiftId = shift.rows[0].id as string;
  console.log(`Seeded shift ${shiftId.slice(0,8)}\n`);

  try {
    // Fire two INSERTs in parallel from two independent connections
    const insertSql =
      `INSERT INTO shift_sessions
         (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords)
       VALUES ($1, $2, $3, NOW(), '0,0') RETURNING id`;

    const results = await Promise.allSettled([
      pool.query(insertSql, [shiftId, guardId, siteId]),
      pool.query(insertSql, [shiftId, guardId, siteId]),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected  = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

    console.log(`Parallel INSERT results: ${fulfilled.length} fulfilled, ${rejected.length} rejected`);
    for (const r of rejected) {
      console.log(`  rejected: code=${r.reason?.code} constraint=${r.reason?.constraint}`);
    }
    console.log();

    assert(fulfilled.length === 1, 'exactly 1 INSERT succeeded');
    assert(rejected.length === 1,  'exactly 1 INSERT failed');
    assert(rejected[0].reason?.code === '23505',
      '23505 unique_violation raised');
    assert(rejected[0].reason?.constraint === 'idx_shift_sessions_one_open_per_guard',
      'rejected by idx_shift_sessions_one_open_per_guard');

    const open = await pool.query(
      'SELECT COUNT(*) AS n FROM shift_sessions WHERE shift_id = $1 AND clocked_out_at IS NULL',
      [shiftId]);
    assert(Number(open.rows[0].n) === 1, 'exactly 1 open session exists after the race');

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    if (!process.argv.includes('--keep')) {
      await pool.query('DELETE FROM shift_sessions WHERE shift_id = $1', [shiftId]);
      await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
      console.log('Cleaned up shift + session(s).');
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
