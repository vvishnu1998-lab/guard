/**
 * Location integrity — ADVISORY detection. Never a blocking path.
 *
 * ── THE HONEST LIMIT — READ BEFORE DESCRIBING THIS TO ANYONE ────────────
 *
 * A mock location set to a coordinate that was never otherwise recorded,
 * with plausible accuracy and plausible jitter, DEFEATS EVERY CHECK IN
 * THIS FILE. No repeated coordinate, no monotonicity violation, no
 * precision break, no sentinel accuracy, no zero-variance cluster.
 *
 * These raise the cost of a naive tool. They do not close the hole.
 *
 * ── AND THE TWO WIRED CHECKS ARE NOT INTERCHANGEABLE ────────────────────
 *
 * Established by controlled reproduction on 2026-08-22, session 047534ca,
 * on a device whose mock state we set directly:
 *
 *   c2 (monotonicity) DID NOT FIRE, and that is STRUCTURALLY CORRECT.
 *   c2 detects a coordinate RESURRECTED across a gap — reappearing after a
 *   different, newer fix was recorded. A single UNINTERRUPTED mocked burst
 *   is not that shape. c2 caught the 2026-08-20/21 sessions only because
 *   those bursts were INTERLEAVED with genuine fixes across days.
 *
 *   c4 (accuracy sentinel) DID fire, and carried the whole detection.
 *
 * So in the single-burst case — mock on, do the shift, mock off — c4 is the
 * ONLY check that sees anything. And c4 detects exactly ONE tool's
 * fingerprint: float32(0.01). It generalises across INSTALLS of that tool
 * (verified across two devices, two tenants, two guards, separate installs)
 * but says nothing about any other tool.
 *
 * NET: a different mock app with plausible accuracy and jitter defeats
 * BOTH wired checks. Only `location_mocked` sees that case, and only on
 * Android. Never describe these checks as mock detection; they are
 * heuristics against one tool plus one behavioural pattern.
 *
 * Only `location_mocked` populated fleet-wide closes it:
 *   Android — shipped (Wave 1 OTA, group 966b8f66, runtime 1.0.16)
 *   iOS     — NOT AVAILABLE. Needs our own Swift module exposing
 *             CLLocation.sourceInformation plus a new EAS build, blocked
 *             while the Apple 2.5.4 appeal is open.
 *
 * Until iOS ships, this is not platform-wide protection and must never be
 * described as such.
 *
 * ── RULES ───────────────────────────────────────────────────────────────
 *
 * Nothing here runs on a request path. Nothing rejects. Nothing returns a
 * 4xx. Nothing is shown to a guard. Output is a row in
 * location_integrity_flags for a human to read.
 *
 * ── FALSE-POSITIVE RATE: UNKNOWN ────────────────────────────────────────
 *
 * One labelled positive, ZERO labelled negatives (no row anywhere carries
 * location_mocked = false). No FP rate is computable. The 14.6% from
 * backtesting is a FLAG RATE against mostly-unlabelled sessions — do not
 * present it as an FP rate.
 */
import { pool } from '../db/pool';

/**
 * Shared event view: every client-submitted GPS write, one shape.
 * Kept as a CTE string so each check reads identically.
 */
const EVENT_VIEW = `
  ev AS (
    SELECT lp.shift_session_id sid, lp.guard_id gid, lp.site_id site, lp.pinged_at ts,
           'ping' src, lp.accuracy_meters acc,
           lp.latitude::text||','||lp.longitude::text coord, lp.latitude::text lat
      FROM location_pings lp
    UNION ALL
    SELECT r.shift_session_id, ss.guard_id, r.site_id, r.reported_at,
           'report', r.accuracy_meters,
           r.latitude::text||','||r.longitude::text, r.latitude::text
      FROM reports r JOIN shift_sessions ss ON ss.id = r.shift_session_id
     WHERE r.latitude IS NOT NULL
    UNION ALL
    SELECT v.shift_session_id, v.guard_id, v.site_id, v.verified_at,
           'clock-in-verification', v.accuracy_meters,
           v.verified_lat::text||','||v.verified_lng::text, v.verified_lat::text
      FROM clock_in_verifications v
    UNION ALL
    SELECT ss.id, ss.guard_id, ss.site_id, ss.clocked_in_at,
           'clock-in', ss.clock_in_accuracy_meters,
           replace(replace(ss.clock_in_coords,'(',''),')',''),
           split_part(trim(both '()' from ss.clock_in_coords),',',1)
      FROM shift_sessions ss
    UNION ALL
    SELECT cs.shift_session_id, cs.guard_id, cs.site_id, cs.scanned_at,
           'checkpoint-scan', cs.accuracy_m,
           cs.scan_lat::text||','||cs.scan_lng::text, cs.scan_lat::text
      FROM checkpoint_scans cs
  )`;

// ─── WIRED CHECK 1 (PRIMARY) — monotonicity violation ─────────────────────
//
// The OS last-known-location store is MONOTONIC: it holds the most recent
// fix. A coordinate that reappears AFTER a different, newer fix was recorded
// for that guard therefore cannot have come from it — the value is stored
// somewhere else.
//
// Mechanism-independent: it does not care what tool produced the value, only
// that the ordering is impossible. This is why it is the primary check.
const Q_MONOTONICITY = `
WITH ${EVENT_VIEW},
spans AS (
  SELECT gid, coord, min(ts) t0, max(ts) t1, count(*) uses
    FROM ev GROUP BY gid, coord HAVING count(*) > 1
)
SELECT e.sid, e.gid, e.site AS site_id,
       min(s.t0) AS first_event_at, max(s.t1) AS last_event_at,
       jsonb_build_object(
         'coordinate',            s.coord,
         'uses_of_coordinate',    max(s.uses),
         'first_use',             min(s.t0),
         'last_use',              max(s.t1),
         'intervening_different_fixes',
           (SELECT count(*) FROM ev x
             WHERE x.gid = s.gid AND x.coord <> s.coord AND x.ts > s.t0 AND x.ts < s.t1),
         'first_intervening_fix_at',
           (SELECT min(x.ts) FROM ev x
             WHERE x.gid = s.gid AND x.coord <> s.coord AND x.ts > s.t0 AND x.ts < s.t1),
         'why', 'coordinate reappeared after a different, newer fix was recorded for this guard'
       ) AS evidence
  FROM ev e
  JOIN spans s ON s.gid = e.gid AND s.coord = e.coord
 WHERE EXISTS (SELECT 1 FROM ev x
                WHERE x.gid = s.gid AND x.coord <> s.coord AND x.ts > s.t0 AND x.ts < s.t1)
   AND e.ts >= NOW() - ($1::int || ' days')::interval
 GROUP BY e.sid, e.gid, e.site, s.coord, s.gid, s.t0, s.t1`;

// ─── WIRED CHECK 2 (SECONDARY) — accuracy sentinel ────────────────────────
//
// NARROW BY CONSTRUCTION. Detects ONE tool's fingerprint: an accuracy below
// 1 metre, which no genuine GPS receiver reports. At time of writing the
// only sub-1.0 value in the entire database is 0.009999999776482582 —
// exactly float32(0.01).
//
// A different app with realistic accuracy is completely invisible to this.
// It is kept because when it does fire it is exact, not because it is broad.
const Q_SENTINEL = `
WITH ${EVENT_VIEW}
SELECT e.sid, e.gid, e.site AS site_id,
       min(e.ts) AS first_event_at, max(e.ts) AS last_event_at,
       jsonb_build_object(
         'rows_below_1m',      count(*),
         'distinct_values',    array_agg(DISTINCT e.acc::text),
         'distinct_coords',    count(DISTINCT e.coord),
         'sources',            array_agg(DISTINCT e.src),
         'why', 'accuracy below 1 m — no genuine GPS receiver reports this'
       ) AS evidence
  FROM ev e
 WHERE e.acc IS NOT NULL AND e.acc < 1.0
   AND e.ts >= NOW() - ($1::int || ' days')::interval
 GROUP BY e.sid, e.gid, e.site`;

/* ───────────────────────────────────────────────────────────────────────────
 * SPECCED BUT DELIBERATELY NOT WIRED. Kept so the reasoning is not lost.
 * Do not enable any of these without new evidence.
 *
 * coordinate_repeat — same full-precision coordinate on 2+ distinct Pacific
 *   dates for one guard. In backtesting it flagged NOTHING the two wired
 *   checks did not already catch. Pure redundancy.
 *
 *     GROUP BY gid, coord
 *     HAVING count(DISTINCT (ts AT TIME ZONE 'America/Los_Angeles')::date) >= 2
 *
 * precision_break — rows whose decimal count differs from the session's own
 *   band (iOS emits 10-15 dp, Android <=7 dp). NET NEGATIVE: it MISSED the
 *   one confirmed positive, because that session was uniformly high
 *   precision and had no minority band to detect; and it produced BOTH of
 *   the only plausible false positives in backtesting, on a guard who
 *   genuinely switched platforms mid-history. It detects a provider toggled
 *   MID-SESSION and nothing else.
 *
 *     bands AS (SELECT sid, CASE WHEN length(split_part(lat,'.',2)) >= 10
 *                               THEN 'hi' ELSE 'lo' END b FROM ev)
 *     GROUP BY sid HAVING count(*) FILTER (WHERE b='hi') > 0
 *                     AND count(*) FILTER (WHERE b='lo') > 0
 *
 * zero_variance — one accuracy value with no spread across a whole session.
 *   Perfect precision in backtesting, but ONLY because that session was 100%
 *   mocked. A provider toggled part-way through leaves variance and walks
 *   straight past it.
 *
 *     GROUP BY sid HAVING count(DISTINCT acc) = 1 AND count(*) >= 3
 * ─────────────────────────────────────────────────────────────────────────*/

export interface IntegrityScanResult {
  checkName: string;
  inserted: number;
  matched: number;
}

/**
 * Run the wired checks and upsert findings.
 *
 * ON CONFLICT DO NOTHING against uq_location_integrity_session_check means a
 * re-run never duplicates and — critically — NEVER RESURRECTS A ROW A HUMAN
 * ALREADY DISMISSED. A resolved flag stays resolved.
 *
 * Never throws: a detection job must not be able to take down the cron.
 */
export async function runLocationIntegrityScan(lookbackDays = 30): Promise<IntegrityScanResult[]> {
  const checks: Array<{ name: string; sql: string }> = [
    { name: 'monotonicity_violation', sql: Q_MONOTONICITY },
    { name: 'accuracy_sentinel',      sql: Q_SENTINEL },
  ];

  const results: IntegrityScanResult[] = [];

  for (const check of checks) {
    try {
      const found = await pool.query(check.sql, [lookbackDays]);
      let inserted = 0;
      for (const row of found.rows) {
        const ins = await pool.query(
          `INSERT INTO location_integrity_flags
             (shift_session_id, guard_id, site_id, check_name, evidence, first_event_at, last_event_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (shift_session_id, check_name) DO NOTHING
           RETURNING id`,
          [row.sid, row.gid, row.site_id, check.name, row.evidence, row.first_event_at, row.last_event_at],
        );
        if (ins.rowCount) inserted++;
      }
      results.push({ checkName: check.name, inserted, matched: found.rowCount ?? 0 });
      console.log(`[integrity.scan] check=${check.name} matched=${found.rowCount} inserted=${inserted}`);
    } catch (err: any) {
      // Advisory job. A failing check must not break the others or the cron.
      console.error(`[integrity.scan] check=${check.name} FAILED: ${err?.message ?? err}`);
      results.push({ checkName: check.name, inserted: 0, matched: 0 });
    }
  }

  return results;
}
