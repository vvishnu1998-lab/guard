/**
 * The INSERT both missed-window crons use (jobs/missedPingCron.ts,
 * jobs/missedReportCron.ts), in one place.
 *
 * WHY IT RE-CHECKS THE SHIFT'S END (U2, decision 2a, 2026-09-28). Each cron
 * reads its sessions — and each shift's scheduled_end — ONCE per tick, then
 * inserts one row per missed window in separate autocommit statements. An
 * admin who closes a shift in the past (PATCH /api/shifts/:id, active branch)
 * deletes that session's rows for windows ending after the new end and moves
 * scheduled_end back, in one transaction. A tick that read the OLD end before
 * that commit would otherwise insert a row for a window the shift no longer
 * has, after the delete — a miss the guard can never answer (the session is
 * closed) and that the activity log shows as "Missed Ping".
 *
 * So the row is written only while the shift's CURRENT end still covers the
 * window (window_end <= scheduled_end: the trackable-window rule R3,
 * services/pingWindows.ts), read under FOR SHARE. FOR SHARE is what makes it
 * hold under concurrency, not just usually: if the admin's transaction holds
 * the shift row (FOR UPDATE), this statement waits for it, and Postgres
 * re-evaluates the condition against the committed row — the new end — so
 * the insert does not happen. A plain snapshot read could still see the old
 * end. The wait is one statement long; this takes no other lock first.
 *
 * Nothing else changes: same columns, same ON CONFLICT dedup, same RETURNING
 * (no row back = nothing written = no push).
 *
 * Parameters: $1 session, $2 site, $3 guard, $4 window_start, $5 window_end,
 * $6 window_label, $7 expires_at, $8 shift id. Cast explicitly: in
 * INSERT … SELECT the select list does not inherit the column types.
 */
export function missedWindowInsertSql(table: 'missed_pings' | 'missed_reports'): string {
  return `INSERT INTO ${table}
             (shift_session_id, site_id, guard_id,
              window_start, window_end, window_label, expires_at)
           SELECT $1::uuid, $2::uuid, $3::uuid,
                  $4::timestamptz, $5::timestamptz, $6::varchar, $7::timestamptz
            WHERE EXISTS (
                    SELECT 1 FROM shifts s
                     WHERE s.id = $8::uuid
                       AND s.scheduled_end >= $5::timestamptz
                       FOR SHARE
                  )
           ON CONFLICT (shift_session_id, window_start) DO NOTHING
           RETURNING id`;
}
