/**
 * Data-retention tier constants and helpers.
 *
 * Every retention-eligible table gets an `expires_at` column populated
 * at INSERT via `expiresAtFor(...)`. The nightly purge cron
 * (apps/api/src/jobs/nightlyPurge.ts) deletes rows whose `expires_at`
 * has passed AND `legal_hold = false`.
 *
 * Tiers below are the schedule locked 2026-09-19. They REPLACE the original
 * retention-rebuild RFC sizing; schema_v79 recomputes every existing
 * `expires_at` from each row's own EVENT timestamp to match.
 *
 * ── SHIFTS AND SHIFT_SESSIONS ARE BOTH 1500, AND THAT PAIRING IS LOAD-BEARING
 *
 * `shift_sessions_shift_id_fkey` is ON DELETE CASCADE from `shifts`, and
 * `reports_shift_session_id_fkey` is ON DELETE CASCADE from `shift_sessions`.
 * So a shift that expires before its session takes the session AND the
 * session's 1500-day incident reports with it, silently.
 *
 * The locked schedule first said shifts 1460 / sessions 1500. Measured
 * 2026-09-19: that inverts on 345 of 345 sessions by an average of 40.13
 * days, and 670 of 712 shifts have no NO-ACTION child to raise an error, so
 * 611 reports would go without a single exception being thrown. Raising
 * sessions alone moved the inversion up a level rather than clearing it.
 *
 * EQUAL tiers are the fix here only because the cascade is the hazard: with
 * both at 1500 the pair reverts to the pre-existing sub-day ordering (253 of
 * 345, driven by clocked_in_at vs scheduled_start drift), which step order
 * inside one nightly run already handles. If either value is ever changed
 * again, change both, or re-derive the cascade first.
 *
 * ── WHAT IS DELIBERATELY NOT IN THIS BLOCK
 *
 * The locked schedule also covers 18 tables with NO `expires_at` column —
 * notifications 30d, auth logs 365d, login attempts 90d, and so on. Those
 * tiers are computed INLINE at purge time, and their constants land with the
 * purge steps that read them. They are not added here in advance: an
 * authoritative-looking constant with no reader is exactly what
 * PING_PHOTO_DAYS was, and it misled two audits before it was removed.
 */

export const RETENTION = {
  ACTIVITY_REPORT_DAYS:    730,   // locked 2026-09-19 (was 365)
  MAINTENANCE_REPORT_DAYS: 730,   // locked 2026-09-19 (was 365)
  INCIDENT_REPORT_DAYS:    1500,  // locked 2026-09-19 (was 1095) — evidence tier
  GEOFENCE_VIOLATION_DAYS: 365,   // locked 2026-09-19 (was 1095)
  PING_METADATA_DAYS:      90,    // locked 2026-09-19 (was 365)
  TASK_COMPLETION_DAYS:    365,   // unchanged
  SHIFT_SESSION_DAYS:      1500,  // locked 2026-09-19 (was 1460) — see the cascade note above
  SHIFT_DAYS:              1500,  // locked 2026-09-19 (was 1460) — MUST equal SHIFT_SESSION_DAYS
  MISSED_PING_DAYS:        90,    // locked 2026-09-19 (was 365) — parity with ping metadata
  MISSED_REPORT_DAYS:      730,   // locked 2026-09-19 (was 365) — parity with activity reports
  OFF_POST_EVENT_DAYS:     365,   // locked 2026-09-19 (was 1095) — parity with geofence_violation
  VEHICLE_INSPECTION_DAYS: 365,   // unchanged — inspection photos ARE the evidence artifact
} as const;

/**
 * PING PHOTOS ARE 7 DAYS, AND THAT NUMBER DOES NOT LIVE HERE.
 *
 * There was a `PING_PHOTO_DAYS: 7` constant in the block above until
 * 2026-09-19. It was dead: one reference in the whole repository, its own
 * definition. No `RetentionKind` member, no `KIND_DAYS` entry, so
 * `expiresAtFor()` could not reach it, and its comment ("S3 deletion via
 * cron step 1") described a step that reads the `photo_delete_at` COLUMN and
 * has never read the constant.
 *
 * It is removed rather than wired, because wiring it would change behaviour
 * this file has no business changing: the live clock is a bare literal at
 * routes/locations.ts:506-507 using LOCAL-time `setDate`, while
 * `expiresAtFor` uses `setUTCDate`. Routing the ping path through here would
 * shift every `photo_delete_at` by the UTC offset on the platform's
 * highest-volume write.
 *
 * The two mechanisms that actually enforce 7 days:
 *   1. routes/locations.ts:506-507 — stamps `location_pings.photo_delete_at`.
 *   2. The S3 lifecycle rule `ping-7d` on guard-media-prod (Expiration 7
 *      days, prefix `ping/`). Measured across a 956-of-956 census on
 *      2026-09-19: fires at 7.0-9.0 days, never early. This is the one that
 *      removes the bytes; nightlyPurge step 1 has never run outside dry-run.
 *
 * If ping photos ever move off 7 days, BOTH of those change, and neither is
 * in this file. Do not re-add a constant here unless it gains a reader.
 */

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
  | 'missed_ping'
  | 'missed_report'
  | 'off_post_event'
  | 'vehicle_inspection';

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
  missed_report:      RETENTION.MISSED_REPORT_DAYS,
  off_post_event:     RETENTION.OFF_POST_EVENT_DAYS,
  vehicle_inspection: RETENTION.VEHICLE_INSPECTION_DAYS,
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

/**
 * The three values `reports.report_type` may hold. Mirrors the CHECK at
 * db/schema.sql:113-114 and the request validator at routes/reports.ts:184.
 */
export type ReportType = 'activity' | 'maintenance' | 'incident';

/**
 * Convenience wrapper for the reports-INSERT dispatch on report_type.
 *
 * ── WHY THIS BOTH NARROWS THE TYPE *AND* THROWS ─────────────────────────
 *
 * It used to take `string` and fall through to `default: activity_report`.
 * An unrecognised type therefore got the SHORTEST tier silently — now 730
 * days where an incident is meant to get 1500, so the gap the bug opens
 * grew from 730 days to 770 when this schedule was locked.
 *
 * The union alone does not fix it. The only caller is
 * routes/reports.ts:582, and its argument comes from `req.body`, which is
 * `any` — assignable to any union, so tsc raises nothing there. A union is
 * necessary for typed callers and worth nothing for this one.
 *
 * So the runtime throw is the part that actually works. The exhaustive
 * `never` assignment is the part that catches it at COMPILE time for anyone
 * who adds a fourth ReportType: the switch stops being exhaustive, the
 * assignment stops type-checking, and the build fails before the tier can go
 * wrong.
 *
 * Throwing is safe here and is the lesser evil. reports.ts:184-186 already
 * rejects anything outside the three with a 400, so this is unreachable
 * today. It becomes reachable only if someone widens the CHECK constraint
 * and that validator without touching this file — and a loud 500 plus a
 * Sentry event is strictly better than silently filing evidence under a tier
 * that deletes it 770 days early, which is invisible until the data is gone.
 */
export function expiresAtForReport(reportType: ReportType, from: Date = new Date()): Date {
  switch (reportType) {
    case 'activity':    return expiresAtFor('activity_report', from);
    case 'maintenance': return expiresAtFor('maintenance_report', from);
    case 'incident':    return expiresAtFor('incident_report', from);
  }
  // Unreachable while ReportType has exactly these three members; adding a
  // fourth without a case above makes this assignment a compile error.
  const unhandled: never = reportType;
  throw new Error(
    `expiresAtForReport: unknown report_type ${JSON.stringify(unhandled)} — ` +
    `no retention tier defined. Add a case above rather than letting it ` +
    `default to the shortest tier.`,
  );
}
