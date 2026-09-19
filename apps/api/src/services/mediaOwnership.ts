import { pool } from '../db/pool';

/**
 * Is any surviving row still pointing at this S3 key?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * The purge deletes S3 objects per ROW, but an object is not owned by a row.
 * Measured 2026-09-19: 3,979 pointer values across the 15 columns below
 * resolve to 3,949 distinct keys. Nine keys are referenced more than once,
 * by 39 rows between them:
 *
 *   7 keys × 26 rows   report_photos.storage_url, sharing WITH ITSELF
 *                      (three keys held by 6 rows each, four by 2)
 *   1 key  ×  2 rows   location_pings.photo_url + geofence_violations.photo_url
 *   1 key  × 11 rows   clock_in_verifications.selfie_url — the literal string
 *                      `pending`, which is not an object at all. It normalises
 *                      to itself, so it LOOKS like the most-shared key here;
 *                      deleteS3Object rejects it as malformed before the
 *                      bucket is touched. Counted so the 9 reconciles.
 *
 * That distribution is the whole design. A guard written as "NOT EXISTS in
 * every OTHER pointer column" — the obvious shape — catches exactly 1 of the
 * 8 real ones, because the other seven are rows of the SAME column. The check
 * must include the column being deleted from, which is why this asks a
 * question about rows that still exist rather than about columns.
 *
 * ── IT MUST RUN AFTER THE DELETE, NOT BEFORE ────────────────────────────
 *
 * "Is anyone else pointing at this?" asked while the co-owning rows are still
 * present answers YES for all of them, so the object is never deleted and a
 * permanent orphan replaces the bug. Asked after the DB rows are gone, the
 * surviving references are exactly the ones that should keep the object
 * alive. This is why the S3 sweep moved to a second pass in nightlyPurge —
 * the ordering and this guard are one decision, not two.
 *
 * ── ONE ROUND TRIP, NOT N ───────────────────────────────────────────────
 *
 * deviceRegistry.ts:224-232 states the house rule: batch/joined work takes a
 * SQL fragment because the whole point is one round trip; point lookups take
 * a helper. A per-object NOT EXISTS is neither — it is the N+1 that rule
 * exists to forbid. Measured: the per-key form costs ~11 ms against 4,677
 * scanned rows with no index on any pointer column, which is ~9.5 s per night
 * at today's 858 candidates and grows as O(objects × pointer rows). This asks
 * once per step regardless of how many keys it is given.
 */

/**
 * Every column in the database that stores an S3 key or URL.
 *
 * Kept as data, next to the query that consumes it, for the same reason
 * INHERIT_HOLD_COLUMNS sits beside its fragment in legalHold.ts: the
 * enumeration must live in exactly one place.
 *
 * THIS LIST HAS GROWN FOUR TIMES, ONCE BY FIVE COLUMNS IN A SINGLE
 * MIGRATION (schema_v48's vehicle-inspection slots). Do not assume it is
 * stable — assertPointerColumnsCurrent() below is what catches the next one.
 */
export const POINTER_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['clock_in_verifications', 'selfie_url'],
  ['clock_in_verifications', 'site_photo_url'],
  ['geofence_violations',    'photo_url'],
  ['location_pings',         'photo_url'],
  ['monthly_hours_reports',  's3_url'],
  ['quarantined_uploads',    's3_key'],          // bare key, not a URL
  ['report_photos',          'storage_url'],
  ['shift_sessions',         'clock_out_photo_url'],
  ['sites',                  'instructions_pdf_url'],
  ['task_completions',       'photo_url'],
  ['vehicle_inspections',    'photo_driver_side_url'],
  ['vehicle_inspections',    'photo_front_url'],
  ['vehicle_inspections',    'photo_odometer_url'],
  ['vehicle_inspections',    'photo_passenger_side_url'],
  ['vehicle_inspections',    'photo_rear_url'],
] as const;

/** Column-name shapes that make a text column a media pointer. Used only by
 *  the drift probe; kept beside the list it validates. */
const POINTER_NAME_RE = '(url|photo|selfie|image|s3|pdf|storage)';

/**
 * Normalise a stored value to its S3 key, matching extractS3Key's semantics
 * in SQL: a bare key passes through, a URL loses its scheme and host.
 *
 * Deliberately host-agnostic, unlike deleteS3Object's strict check. Here a
 * foreign-host row still COUNTS AS A REFERENCE — if some row points at
 * `https://elsewhere.example/report/x.jpg`, we do not want to delete our own
 * `report/x.jpg` out from under it. Being permissive is the safe direction
 * for a guard whose job is to STOP a delete.
 */
const NORMALISE = `regexp_replace(v, '^https?://[^/]+/', '')`;

/**
 * Of the given S3 keys, which are still referenced by at least one row?
 *
 * Returns a Set for O(1) membership. An empty input returns an empty Set
 * without querying.
 *
 * FAILS CLOSED. On any error this returns ALL the keys as "still referenced",
 * so the caller deletes nothing. The alternative — treating a failed
 * ownership check as "nobody owns it" — turns a transient database error into
 * permanent object loss. The same reasoning as legalHold.ts's COALESCE,
 * pointing the other way: there the safe default is "not held", here it is
 * "still owned", because the destructive action is on the other side.
 */
export async function keysStillReferenced(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();

  const union = POINTER_COLUMNS
    .map(([t, c]) => `SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL`)
    .join(' UNION ALL ');

  try {
    const { rows } = await pool.query<{ k: string }>(
      `SELECT DISTINCT ${NORMALISE} AS k FROM (${union}) p WHERE ${NORMALISE} = ANY($1::text[])`,
      [keys],
    );
    return new Set(rows.map((r) => r.k));
  } catch (err) {
    console.error(
      `[mediaOwnership] reference check FAILED for ${keys.length} keys — ` +
      `treating all as still referenced and deleting nothing:`, err,
    );
    return new Set(keys);
  }
}

/**
 * Drift control: does POINTER_COLUMNS still match the database?
 *
 * Returns the `table.column` names that look like media pointers but are not
 * in the list. A non-empty result means a migration added a column and this
 * file was not updated, so the ownership check has a blind spot and the S3
 * sweep must not run.
 *
 * The database is the source of truth, not a regex over source files. This is
 * a runtime probe rather than a CI job because the repo's existing TS-vs-SQL
 * gate (.github/workflows/window-anchor.yml) works precisely because its
 * script needs NO schema; a pointer-column check does, so the CI version
 * would mean seeding migrations into the container.
 *
 * Never throws — an unusable probe returns [] and the sweep proceeds, because
 * failing the probe closed would stop all retention on an unrelated error.
 * The blind spot it guards is narrow; the sweep is the whole job.
 */
export async function assertPointerColumnsCurrent(): Promise<string[]> {
  try {
    const known = new Set(POINTER_COLUMNS.map(([t, c]) => `${t}.${c}`));
    const { rows } = await pool.query<{ n: string }>(
      `SELECT c.relname || '.' || a.attname AS n
         FROM pg_attribute a
         JOIN pg_class c     ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid IN (25, 1043, 1042)
          AND a.attname ~ '${POINTER_NAME_RE}'`,
    );
    return rows.map((r) => r.n).filter((n) => !known.has(n));
  } catch (err) {
    console.error('[mediaOwnership] pointer-column drift probe failed:', err);
    return [];
  }
}
