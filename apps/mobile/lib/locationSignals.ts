/**
 * Location signals — anti-spoof Wave 1, CAPTURE ONLY.
 *
 * Derives the two provenance/freshness values the server records alongside
 * every GPS fix, from an expo-location LocationObject.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────
 *
 * NOTHING here may change what a guard sees or whether an action succeeds.
 * These values are computed, sent, and forgotten. No screen reads them, no
 * button is gated on them, no fix is rejected because of them. If you are
 * about to add `if (signals.fixAgeMs > X) return`, stop — that is a later
 * wave, it needs a threshold calibrated on real shadow data, and that data
 * does not exist yet.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * On 2026-08-21 a clock-in coordinate was byte-identical to 15 decimals to
 * a ping the same device had produced 20h06m earlier — the OS returned a
 * cached fix and the app had no way to notice. `fixAgeMs` makes that
 * visible directly: a cached fix reports an age in hours, a live one in
 * seconds.
 *
 * ── SEMANTICS ───────────────────────────────────────────────────────────
 *
 * fixAgeMs   Date.now() - location.timestamp, in ms. Both are device-clock
 *            derived, so the difference is meaningful even if the clock is
 *            wrong in absolute terms. Can be NEGATIVE if the OS timestamp
 *            is ahead of the clock — that is a skew signature and is sent
 *            as-is. The server stores it raw.
 *
 * mocked     Android only: the OS's own mock-provider flag. `undefined` on
 *            iOS, where expo-location does not expose it. Sent as null.
 *            NULL IS NOT INNOCENT — it means unknown, not clean.
 */
import type { LocationObject } from 'expo-location';

export interface LocationSignals {
  /** ms between the OS fix timestamp and now. Raw, may be negative. */
  fix_age_ms: number | null;
  /** Android OS mock-provider flag; null on iOS or when unavailable. */
  location_mocked: boolean | null;
}

/**
 * Derive shadow signals from a location fix.
 *
 * Never throws. A malformed or partial LocationObject yields nulls rather
 * than an error — telemetry must never break a clock-in.
 */
export function locationSignals(loc: LocationObject | null | undefined): LocationSignals {
  if (!loc) return { fix_age_ms: null, location_mocked: null };

  let fix_age_ms: number | null = null;
  const ts = loc.timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const age = Date.now() - ts;
    // Guard only against values that cannot survive the server's INTEGER
    // column. This is NOT a freshness rule and NOT a rejection — an
    // out-of-range age simply becomes "unknown" rather than corrupting the
    // row. |7 days| is far below INTEGER max (~24.8 days in ms).
    if (Number.isFinite(age) && Math.abs(age) <= 7 * 24 * 60 * 60 * 1000) {
      fix_age_ms = Math.round(age);
    }
  }

  // `mocked` is declared `mocked?: boolean` and is populated only by the
  // Android native module (LocationResults.kt). undefined → null.
  const m = (loc as LocationObject & { mocked?: boolean }).mocked;
  const location_mocked = typeof m === 'boolean' ? m : null;

  return { fix_age_ms, location_mocked };
}

/** Empty signals, for call sites that have coordinates but no LocationObject
 *  (e.g. a fix restored from store state). Explicit so the fields are always
 *  present in the payload and their absence is never ambiguous. */
export const NO_LOCATION_SIGNALS: LocationSignals = {
  fix_age_ms: null,
  location_mocked: null,
};
