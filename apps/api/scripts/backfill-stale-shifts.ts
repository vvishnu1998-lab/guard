/**
 * backfill-stale-shifts.ts — one-shot manual sweep for any past-due
 * scheduled/active shifts that the cron missed.
 *
 * Uses the same `autoCompleteOverdueShifts` worker function that
 * apps/api/src/jobs/autoCompleteShifts.ts runs every 5 minutes, so the
 * transitions exactly match steady-state behaviour:
 *   - scheduled with no clock-in → 'missed'
 *   - scheduled/active with ≥1 shift_session → 'completed', open
 *     sessions get clocked_out_at + total_hours computed
 *
 * Idempotent: the worker's WHERE filter is `status IN ('scheduled','active')
 * AND scheduled_end <= NOW()`, so re-running this script after a successful
 * run is a no-op.
 *
 * Usage:
 *   railway run npm run script:backfill-stale-shifts
 *   # or locally:
 *   npx ts-node apps/api/scripts/backfill-stale-shifts.ts
 *
 * Context: 2026-06-10 — a June 3 shift was created backdated on June 10
 * (root cause now fixed by the past-date guard in routes/shifts.ts). The
 * regular cron catches such shifts within 5 minutes, but this script
 * exists so an admin can force the sweep without waiting and so the
 * pattern is documented for future incidents.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool';
import { autoCompleteOverdueShifts } from '../src/jobs/autoCompleteShifts';

async function countStale(): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM shifts
      WHERE status IN ('scheduled','active') AND scheduled_end <= NOW()`,
  );
  return r.rows[0]?.n ?? 0;
}

async function sampleStale(limit = 10) {
  const r = await pool.query(
    `SELECT id, status, scheduled_start, scheduled_end, guard_id, site_id, created_at
       FROM shifts
      WHERE status IN ('scheduled','active') AND scheduled_end <= NOW()
      ORDER BY scheduled_start ASC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

(async function main() {
  console.log('[backfill-stale-shifts] starting');

  const before = await countStale();
  console.log(`  before: ${before} stale shift(s)`);
  if (before > 0) {
    const sample = await sampleStale();
    console.log('  sample (up to 10):');
    for (const row of sample) {
      console.log(
        `    ${row.id}  status=${row.status}  ` +
        `start=${row.scheduled_start.toISOString()}  end=${row.scheduled_end.toISOString()}  ` +
        `created=${row.created_at.toISOString()}`,
      );
    }
  }

  const client = await pool.connect();
  let result;
  try {
    result = await autoCompleteOverdueShifts(client);
  } finally {
    client.release();
  }

  const after = await countStale();
  console.log(
    `  worker: closed ${result.shiftsClosed} shift(s), ` +
    `${result.sessionsClosed} session(s), ${result.breaksClosed} break(s)`,
  );
  console.log(`  after:  ${after} stale shift(s)`);

  if (after !== 0) {
    console.error('✗ backfill did not drain all stale shifts — something else is blocking');
    process.exitCode = 1;
  } else if (before === 0) {
    console.log('✓ no stale shifts found; nothing to do');
  } else {
    console.log(`✓ backfilled ${before} stale shift(s)`);
  }

  await pool.end();
})().catch((err) => {
  console.error('[backfill-stale-shifts] error:', err);
  process.exit(1);
});
