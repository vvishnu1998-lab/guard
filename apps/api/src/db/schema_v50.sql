-- schema_v50 — anti-spoof shadow layer, Wave 1 (2026-08-22)
--
-- NUMBERING NOTE: this shipped as "v46" in the original dispatch. v46 is
-- taken (Break enforcement package, 2026-08-18) and the chain already runs
-- through v49. This is v50.
--
-- PURPOSE
--
-- Record location provenance and freshness on the three write paths that
-- carry a GPS fix. NOTHING in this migration is read by validateAtSite, by
-- any accept/reject branch, or by any client. It is capture only.
--
-- The 2026-08-21 Bethel AME investigation could not answer two questions
-- because the data was never recorded:
--
--   1. What accuracy did an ACCEPTED clock-in report?
--      geofence.reject (routes/shifts.ts) logs accuracy only when a
--      clock-in is REJECTED. Accepted clock-ins log nothing and store
--      nothing. A clock-in accepted from 1,080 m off-post on 2026-08-20
--      is therefore unreconstructable — the accuracy that bought it that
--      budget is gone.
--
--   2. Was the fix fresh, and did the OS consider it mocked?
--      A clock-in coordinate on 2026-08-21 was byte-identical to 15
--      decimals to a ping the same device produced 20h06m earlier. Whether
--      that came from a stale OS cache or an injected value cannot be
--      settled after the fact without fix age and the mock flag.
--
-- Every column here is NULLABLE with NO DEFAULT. Pre-OTA clients will not
-- send these fields; their rows stay NULL and behave exactly as today.
--
-- ── THREE-STATE SEMANTICS — READ THIS BEFORE WRITING ANY QUERY ───────────
--
--   TRUE   the OS explicitly reported the fix came from a mock provider
--   FALSE  the OS explicitly reported the fix did NOT come from a mock
--          provider
--   NULL   UNKNOWN. Not innocent. NULL means one of:
--            - iOS (expo-location exposes `mocked` on Android only);
--            - a client that predates the Wave 1 OTA;
--            - the field was absent or malformed in the request body.
--
--   NULL IS NOT INNOCENT. A query written as `WHERE location_mocked IS NOT
--   TRUE` silently treats every unknown as clean and will read as an
--   all-clear across the entire iOS fleet and every pre-OTA row. Always
--   branch on all three states explicitly.
--
-- fix_age_ms is milliseconds between the OS timestamp on the fix and the
-- moment the client built the request body. It is DEVICE-CLOCK derived, so
-- a skewed device clock can produce a nonsensical value.
--
-- Values are STORED RAW, INCLUDING NEGATIVES. A negative age means the OS
-- fix timestamp is ahead of the device clock at request time — the
-- signature of a skewed clock, which is signal. Shadow mode measures
-- everything and interprets nothing.
--
-- Only unstorable values degrade to NULL (non-numeric, NaN, Infinity, or
-- |value| beyond ~7 days, which would risk INTEGER overflow); those are
-- logged as [shadow.reject]. Any query over this column MUST therefore
-- handle negatives — do not assume >= 0.
--
-- Do not assume the stored values are sane. Characterise the distribution
-- before trusting any threshold built on them.
--
-- NAMING: `_meters` for distances, matching location_pings.accuracy_meters.
-- The schema already carries three conventions (accuracy_meters,
-- accuracy_m, clock_out_accuracy_meters). This migration deliberately does
-- not introduce a fourth. Reconciling the existing three is a separate
-- ticket and is NOT attempted here.

-- ── 1. shift_sessions — the accepted clock-in itself ────────────────────
--
-- shift_sessions already carries clock_out_accuracy_meters (clock-OUT
-- only). There has never been a clock-IN equivalent. That asymmetry is the
-- gap described in (1) above.

ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS clock_in_accuracy_meters DOUBLE PRECISION;

ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS clock_in_location_mocked BOOLEAN;

ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS clock_in_fix_age_ms INTEGER;

COMMENT ON COLUMN shift_sessions.clock_in_accuracy_meters IS
  'Client-reported horizontal accuracy (m) at clock-in. NULL = pre-OTA client or absent/malformed. Capture only; never read by validateAtSite.';
COMMENT ON COLUMN shift_sessions.clock_in_location_mocked IS
  'OS mock-provider flag at clock-in. TRUE=mocked, FALSE=not mocked, NULL=unknown (iOS, pre-OTA, or absent). NULL IS NOT INNOCENT.';
COMMENT ON COLUMN shift_sessions.clock_in_fix_age_ms IS
  'ms between the OS fix timestamp and request build, device-clock derived. STORED RAW incl. negatives (negative = skewed device clock). NULL = unknown/unstorable.';

-- ── 2. clock_in_verifications — the selfie/verification write ───────────

ALTER TABLE clock_in_verifications
  ADD COLUMN IF NOT EXISTS accuracy_meters DOUBLE PRECISION;

ALTER TABLE clock_in_verifications
  ADD COLUMN IF NOT EXISTS location_mocked BOOLEAN;

ALTER TABLE clock_in_verifications
  ADD COLUMN IF NOT EXISTS fix_age_ms INTEGER;

COMMENT ON COLUMN clock_in_verifications.accuracy_meters IS
  'Client-reported horizontal accuracy (m) for verified_lat/verified_lng. NULL = pre-OTA client or absent/malformed.';
COMMENT ON COLUMN clock_in_verifications.location_mocked IS
  'OS mock-provider flag. TRUE=mocked, FALSE=not mocked, NULL=unknown (iOS, pre-OTA, or absent). NULL IS NOT INNOCENT.';
COMMENT ON COLUMN clock_in_verifications.fix_age_ms IS
  'ms between the OS fix timestamp and request build, device-clock derived. STORED RAW incl. negatives (negative = skewed device clock). NULL = unknown/unstorable.';

-- ── 3. location_pings — the ping stream ─────────────────────────────────
--
-- accuracy_meters already exists here and is populated; only provenance
-- and freshness are new.

ALTER TABLE location_pings
  ADD COLUMN IF NOT EXISTS location_mocked BOOLEAN;

ALTER TABLE location_pings
  ADD COLUMN IF NOT EXISTS fix_age_ms INTEGER;

COMMENT ON COLUMN location_pings.location_mocked IS
  'OS mock-provider flag. TRUE=mocked, FALSE=not mocked, NULL=unknown (iOS, pre-OTA, or absent). NULL IS NOT INNOCENT.';
COMMENT ON COLUMN location_pings.fix_age_ms IS
  'ms between the OS fix timestamp and request build, device-clock derived. STORED RAW incl. negatives (negative = skewed device clock). NULL = unknown/unstorable.';

-- ── NOT DONE HERE, DELIBERATELY ─────────────────────────────────────────
--
--   * No accuracy ceiling. A ceiling cannot be calibrated until this table
--     has real numbers. The honest observed range already spans 0.01 m to
--     660.41 m, and the 660.41 m reading was a real guard on a real
--     overnight shift — a guessed ceiling would have locked him out.
--   * No index. Nothing queries these columns on a hot path yet, and an
--     index on an all-NULL column earns nothing. Add one when a shadow
--     query needs it.
--   * No backfill. Existing rows have no provenance and never will.
--   * No NOT NULL, no DEFAULT. Both would rewrite live tables belonging to
--     a paying customer for zero benefit.
--   * No change to validateAtSite, to any accept/reject branch, or to the
--     accuracy validation inconsistency at routes/shifts.ts:1606 /
--     routes/shifts.ts:2529 / routes/locations.ts:841. That inconsistency
--     is real and is a SEPARATE ticket; touching it here would risk a
--     behaviour change in a wave whose whole point is that there is none.
