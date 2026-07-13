/**
 * Data-retention tier constants and helpers.
 *
 * Every retention-eligible table gets an `expires_at` column populated
 * at INSERT via `expiresAtFor(...)`. The nightly purge cron
 * (apps/api/src/jobs/nightlyPurge.ts) deletes rows whose `expires_at`
 * has passed AND `legal_hold = false`.
 *
 * Tiers were sized in the retention rebuild RFC:
 *   - Reports: 1 year default; incidents 3 years for evidence
 *   - Pings: metadata 1 year (audit trail); photos 7 days (privacy)
 *   - Task completions: 1 year (matches activity reports)
 *   - Shift sessions + shifts: 4 years (payroll + labor-law lookback)
 *   - Geofence violations: 3 years (matches incident evidence tier)
 *
 * The SQL side (schema_v33.sql) hard-codes the same day counts in the
 * backfill UPDATE — keep them in sync.
 */

export const RETENTION = {
  ACTIVITY_REPORT_DAYS:    365,
  MAINTENANCE_REPORT_DAYS: 365,
  INCIDENT_REPORT_DAYS:    1095,
  GEOFENCE_VIOLATION_DAYS: 1095,
  PING_METADATA_DAYS:      365,   // RC2 revision: 1 year, not 90 days
  PING_PHOTO_DAYS:         7,     // unchanged — S3 deletion via cron step 1
  TASK_COMPLETION_DAYS:    365,
  SHIFT_SESSION_DAYS:      1460,
  SHIFT_DAYS:              1460,
  MISSED_PING_DAYS:        365,   // parity with ping metadata (audit trail)
} as const;

/**
 * Named "kind" strings for `expiresAtFor()`. Keep separate from the
 * report_type / row type strings elsewhere so a downstream schema
 * change (e.g. adding a report_type) doesn't silently break this lookup.
 */
export type RetentionKind =
  | 'activity_report'
  | 'maintenance_report'
  | 'incident_report'
  | 'geofence_violation'
  | 'ping_metadata'
  | 'task_completion'
  | 'shift_session'
  | 'shift'
  | 'missed_ping';

const KIND_DAYS: Record<RetentionKind, number> = {
  activity_report:    RETENTION.ACTIVITY_REPORT_DAYS,
  maintenance_report: RETENTION.MAINTENANCE_REPORT_DAYS,
  incident_report:    RETENTION.INCIDENT_REPORT_DAYS,
  geofence_violation: RETENTION.GEOFENCE_VIOLATION_DAYS,
  ping_metadata:      RETENTION.PING_METADATA_DAYS,
  task_completion:    RETENTION.TASK_COMPLETION_DAYS,
  shift_session:      RETENTION.SHIFT_SESSION_DAYS,
  shift:              RETENTION.SHIFT_DAYS,
  missed_ping:        RETENTION.MISSED_PING_DAYS,
};

/**
 * Returns a Date for `NOW() + tier days`. INSERT call sites should
 * always populate `expires_at` with this — never NULL, so the
 * purge's `expires_at < NOW()` predicate can't accidentally match.
 */
export function expiresAtFor(kind: RetentionKind, from: Date = new Date()): Date {
  const days = KIND_DAYS[kind];
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Convenience wrapper for the reports-INSERT dispatch on report_type. */
export function expiresAtForReport(reportType: string, from: Date = new Date()): Date {
  switch (reportType) {
    case 'activity':    return expiresAtFor('activity_report', from);
    case 'maintenance': return expiresAtFor('maintenance_report', from);
    case 'incident':    return expiresAtFor('incident_report', from);
    default:            return expiresAtFor('activity_report', from);
  }
}
