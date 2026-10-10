/**
 * The clock-in-verification write, made safe to repeat.
 *
 * NETRAOPS-API-X (2026-09-24, STARNET): the first POST wrote its row but the
 * client dropped the response (Railway 499). Step 4 re-ran on the guard's
 * retry, the clock-in POST replayed its cached 201 via the Idempotency-Key,
 * and this INSERT hit UNIQUE (shift_session_id) → unhandled 23505 → 500. The
 * guard was already clocked in and saw "HTTP 500" twice.
 *
 * A second verification for the same session is therefore an expected retry,
 * not an error. The FIRST row wins and is never overwritten — its selfie is
 * the evidence of who stood at the post. The retry's freshly uploaded selfie
 * is discarded (left in S3, not linked).
 *
 * Ownership is the caller's job and must run first: the route already 404s a
 * session that is not the requesting guard's. The guard_id filter on the
 * fallback SELECT below is a second, independent fence so this function can
 * never hand one guard another guard's row even if a caller forgets.
 */
import { INHERIT_HOLD_COLUMNS, INHERIT_HOLD_FROM_SESSION_SQL } from './legalHold';

/** Anything with a pg-compatible `.query()` — accepts `pool` or a `PoolClient`. */
type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

export interface ClockInVerificationInput {
  shiftSessionId: string;
  selfieUrl: string | null;
  sitePhotoUrl: string | null;
  verifiedLat: number;
  verifiedLng: number;
  accuracyMeters: number | null;
  locationMocked: boolean | null;
  fixAgeMs: number | null;
}

export type ClockInVerificationWrite =
  /** New row written. */
  | { kind: 'created'; row: Record<string, unknown> }
  /** A row already existed for this session and belongs to this guard. */
  | { kind: 'existing'; row: Record<string, unknown> }
  /** A row exists (or vanished mid-flight) that this guard may not see. */
  | { kind: 'conflict' };

export async function writeClockInVerification(
  db: Queryable,
  guardId: string,
  v: ClockInVerificationInput,
): Promise<ClockInVerificationWrite> {
  // HOLD INHERITED AT INSERT (schema_v80) — see the note at the call site in
  // routes/locations.ts on the shadowed `ss` alias; it is deliberate.
  //
  // is_within_geofence is always true: the route only reaches this point
  // after its own server-side validateAtSite passed.
  const inserted = await db.query(
    `INSERT INTO clock_in_verifications
       (shift_session_id, guard_id, site_id, selfie_url, site_photo_url, verified_lat, verified_lng, is_within_geofence,
        accuracy_meters, location_mocked, fix_age_ms, ${INHERIT_HOLD_COLUMNS})
     SELECT $1, ss.guard_id, ss.site_id, $2, $3, $4, $5, $6, $7, $8, $9,
            ${INHERIT_HOLD_FROM_SESSION_SQL('$1')}
     FROM shift_sessions ss WHERE ss.id = $1
     ON CONFLICT (shift_session_id) DO NOTHING
     RETURNING *`,
    [v.shiftSessionId, v.selfieUrl, v.sitePhotoUrl, v.verifiedLat, v.verifiedLng, true,
     v.accuracyMeters, v.locationMocked, v.fixAgeMs],
  );
  if (inserted.rows[0]) return { kind: 'created', row: inserted.rows[0] };

  const existing = await db.query(
    `SELECT * FROM clock_in_verifications WHERE shift_session_id = $1 AND guard_id = $2`,
    [v.shiftSessionId, guardId],
  );
  if (existing.rows[0]) return { kind: 'existing', row: existing.rows[0] };

  return { kind: 'conflict' };
}
