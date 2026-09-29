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
 * AND scheduled_end + <the auto-close grace> <= NOW()` (autoCloseDueSql,
 * constants/autoCloseGrace.ts), and countStale / sampleStale below use the
 * same predicate, so re-running this script after a successful run is a
 * no-op. A shift still inside the grace is not stale: the worker leaves it for
 * the cron, and so does this count. (Until U4b these counted from
 * scheduled_end itself, so any shift inside the grace made the script report
 * "did not drain" — and the process never exited, because the job module's
 * cron kept it alive; main() now stops that cron first.)
 *
 * The after-count is judged at an instant read just BEFORE the worker ran, so
 * a shift whose grace ends while the worker is running is not misreported as
 * "did not drain": the worker's own NOW() is that instant or later.
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
import cron from 'node-cron';
import { pool } from '../src/db/pool';
import { autoCompleteOverdueShifts } from '../src/jobs/autoCompleteShifts';
import { autoCloseDueSql } from '../src/constants/autoCloseGrace';

async function countStale(asOf?: Date): Promise<number> {
  const r = asOf
    ? await pool.query(
        `SELECT COUNT(*)::int AS n FROM shifts
          WHERE status IN ('scheduled','active') AND ${autoCloseDueSql('scheduled_end', '$1::timestamptz')}`,
        [asOf],
      )
    : await pool.query(
        `SELECT COUNT(*)::int AS n FROM shifts
          WHERE status IN ('scheduled','active') AND ${autoCloseDueSql('scheduled_end')}`,
      );
  return r.rows[0]?.n ?? 0;
}

async function sampleStale(limit = 10) {
  const r = await pool.query(
    `SELECT id, status, scheduled_start, scheduled_end, guard_id, site_id, created_at
       FROM shifts
      WHERE status IN ('scheduled','active') AND ${autoCloseDueSql('scheduled_end')}
      ORDER BY scheduled_start ASC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

(async function main() {
  // Importing the job module scheduled its cron through runJob(). Stop every
  // node-cron task before the first await, so no tick can run underneath this
  // one-shot sweep and the process can exit after pool.end() (a scheduled task
  // re-arms a timer that keeps it alive). Same as test-auto-complete-shifts.ts.
  for (const task of cron.getTasks().values()) task.stop();

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

  // Before the worker's BEGIN, so the worker's NOW() is this instant or later.
  const asOf = (await pool.query<{ t: Date }>('SELECT NOW() AS t')).rows[0].t;
  const client = await pool.connect();
  let result;
  try {
    result = await autoCompleteOverdueShifts(client);
  } finally {
    client.release();
  }

  const after = await countStale(asOf);
  console.log(
    `  worker: closed ${result.shiftsClosed} shift(s), ` +
    `${result.sessionsClosed} session(s), ${result.breaksClosed} break(s)`,
  );
  console.log(`  after:  ${after} stale shift(s)`);

  if (after !== 0) {
    console.error('✗ backfill did not drain all stale shifts — something else is blocking');
    process.exitCode = 1;
  } else if (result.shiftsClosed === 0) {
    console.log('✓ no stale shifts found; nothing to do');
  } else {
    console.log(`✓ backfilled ${result.shiftsClosed} stale shift(s)`);
  }

  await pool.end();
})().catch((err) => {
  console.error('[backfill-stale-shifts] error:', err);
  process.exit(1);
});
