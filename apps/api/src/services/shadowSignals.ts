/**
 * Shadow signals — anti-spoof Wave 1, CAPTURE ONLY.
 *
 * Sanitises the three provenance/freshness fields the mobile client may
 * send alongside a GPS fix, so every write path stores them identically.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────
 *
 * NOTHING here may ever influence whether a request succeeds. Every field
 * is optional. Every malformed value degrades to NULL and the request
 * CONTINUES. This module must never throw, never return a rejection, and
 * never be consulted by validateAtSite or by any accept/reject branch.
 *
 * If you are reading this because you want to gate a clock-in on
 * `location_mocked`, stop: that is a later wave, it needs a fail-open
 * design and a calibrated threshold, and neither exists yet.
 *
 * ── THREE-STATE SEMANTICS ───────────────────────────────────────────────
 *
 *   mocked TRUE   the OS reported the fix came from a mock provider
 *   mocked FALSE  the OS reported it did not
 *   mocked NULL   UNKNOWN — iOS (the flag is Android-only), a pre-OTA
 *                 client, or an absent/malformed field.
 *
 * NULL IS NOT INNOCENT. `WHERE location_mocked IS NOT TRUE` reads as an
 * all-clear across the entire iOS fleet and every pre-OTA row. Branch on
 * all three states explicitly.
 */

export interface ShadowSignals {
  /** Client-reported horizontal accuracy in metres, or null. */
  accuracyMeters: number | null;
  /** OS mock-provider flag: true / false / null (unknown). */
  locationMocked: boolean | null;
  /** ms between the OS fix timestamp and request build, or null. */
  fixAgeMs: number | null;
}

/** Absurd magnitude bound purely to keep an INTEGER column from
 *  overflowing — NOT a geofence rule, never consulted by validateAtSite,
 *  and NOT a freshness threshold. Applied to |fix_age_ms| so negatives are
 *  kept. A magnitude above ~7 days is a broken device clock, not a stale
 *  cache. INTEGER max is ~2.1e9 ms (~24.8 days), so this stays well clear. */
const FIX_AGE_SANITY_CEILING_MS = 7 * 24 * 60 * 60 * 1000;

interface RawBody {
  accuracy?: unknown;
  location_mocked?: unknown;
  fix_age_ms?: unknown;
}

/**
 * Read and sanitise the shadow fields from a request body.
 *
 * @param body   req.body (unknown shape — never trusted)
 * @param ctx    short route label used only in the reject log line
 * @param accuracyOverride
 *               when the caller has ALREADY sanitised accuracy for its own
 *               use (e.g. routes/locations.ts ping, which computes
 *               accuracyM before the fence check), pass it so we store the
 *               identical value rather than re-deriving it.
 */
export function readShadowSignals(
  body: unknown,
  ctx: string,
  accuracyOverride?: number | null,
): ShadowSignals {
  const b = (body ?? {}) as RawBody;
  const rejected: string[] = [];

  // ── accuracy ──────────────────────────────────────────────────────────
  let accuracyMeters: number | null;
  if (accuracyOverride !== undefined) {
    accuracyMeters = accuracyOverride;
  } else if (b.accuracy === undefined || b.accuracy === null) {
    accuracyMeters = null;
  } else if (
    typeof b.accuracy === 'number' &&
    Number.isFinite(b.accuracy) &&
    b.accuracy >= 0
  ) {
    accuracyMeters = b.accuracy;
  } else {
    accuracyMeters = null;
    rejected.push(`accuracy=${JSON.stringify(b.accuracy)}`);
  }

  // ── location_mocked ───────────────────────────────────────────────────
  // Strictly boolean. A string "true" is a client bug, not a verdict — we
  // will not coerce it, because coercing would manufacture a TRUE that the
  // OS never reported.
  let locationMocked: boolean | null;
  if (b.location_mocked === undefined || b.location_mocked === null) {
    locationMocked = null;
  } else if (typeof b.location_mocked === 'boolean') {
    locationMocked = b.location_mocked;
  } else {
    locationMocked = null;
    rejected.push(`location_mocked=${JSON.stringify(b.location_mocked)}`);
  }

  // ── fix_age_ms ────────────────────────────────────────────────────────
  // STORED RAW, INCLUDING NEGATIVES. A negative age means the OS fix
  // timestamp is ahead of the device clock at request time — the signature
  // of a skewed clock, which is signal, not noise. Shadow mode measures
  // everything and interprets nothing, so we do not discard it.
  //
  // Only values that cannot be stored at all are rejected: non-numbers,
  // NaN, Infinity, and magnitudes beyond the sanity ceiling (a broken
  // clock, not a stale cache) — the latter because INTEGER would overflow
  // and fail the INSERT, which would change behaviour.
  let fixAgeMs: number | null;
  if (b.fix_age_ms === undefined || b.fix_age_ms === null) {
    fixAgeMs = null;
  } else if (
    typeof b.fix_age_ms === 'number' &&
    Number.isFinite(b.fix_age_ms) &&
    Math.abs(b.fix_age_ms) <= FIX_AGE_SANITY_CEILING_MS
  ) {
    fixAgeMs = Math.round(b.fix_age_ms);
  } else {
    fixAgeMs = null;
    rejected.push(`fix_age_ms=${JSON.stringify(b.fix_age_ms)}`);
  }

  if (rejected.length > 0) {
    // Single line, then CONTINUE. This is never an error path.
    console.log(`[shadow.reject] ctx=${ctx} ${rejected.join(' ')}`);
  }

  return { accuracyMeters, locationMocked, fixAgeMs };
}
