-- schema_v51 — location integrity review queue (2026-08-22)
--
-- ── THE HONEST LIMIT — READ THIS FIRST ──────────────────────────────────
--
-- A mock location set to a coordinate that was never otherwise recorded,
-- with plausible accuracy and plausible jitter, DEFEATS EVERY CHECK IN
-- THIS TABLE. It produces no repeated coordinate, no monotonicity
-- violation, no precision break, no sentinel accuracy, and no
-- zero-variance cluster.
--
-- These checks raise the cost of a naive tool. They do not close the hole.
--
-- The only thing that closes it is `location_mocked` populated fleet-wide:
--   Android — shipped (Wave 1 OTA, group 966b8f66, runtime 1.0.16)
--   iOS     — NOT AVAILABLE. expo-location does not expose
--             CLLocation.sourceInformation; it needs our own Swift module
--             and a new EAS build, and that is blocked while the Apple
--             2.5.4 appeal is open.
--
-- Until iOS ships, any description of this as platform-wide protection is
-- false.
--
-- ── WHAT THIS TABLE IS ──────────────────────────────────────────────────
--
-- An ADVISORY review queue written by a nightly job. It is NEVER consulted
-- on a request path. Nothing here rejects a write, returns a 4xx, or is
-- shown to a guard. A row means "a human should look at this", nothing
-- more.
--
-- Two checks are wired (see services/locationIntegrity.ts):
--
--   monotonicity_violation  PRIMARY. Mechanism-independent. A coordinate
--                           reappearing AFTER a different, newer fix was
--                           recorded for that guard. The OS last-known
--                           store is monotonic, so it cannot produce this.
--                           Caught the one confirmed positive; produced no
--                           plausible false positive in backtesting.
--
--   accuracy_sentinel       SECONDARY. Exact but narrow: it detects ONE
--                           tool's fingerprint (float32(0.01), the only
--                           sub-1.0 m accuracy value in the database). A
--                           different app with realistic accuracy is
--                           invisible to it.
--
-- Three further checks are specced and their SQL is kept in
-- services/locationIntegrity.ts, DELIBERATELY NOT WIRED:
--
--   coordinate_repeat   flags nothing the two wired checks miss.
--   precision_break     MISSES the confirmed positive (that session was
--                       uniformly high-precision, so there was no minority
--                       band to detect) AND produced both of the only
--                       plausible false positives in backtesting, on a
--                       guard who genuinely switched platforms. Net
--                       negative. Do not wire it without new evidence.
--   zero_variance       only fires on a session that is 100% mocked; a
--                       provider toggled mid-shift walks straight past.
--
-- ── FALSE-POSITIVE RATE: UNKNOWN, AND DO NOT QUOTE ONE ──────────────────
--
-- At the time of writing the database holds ONE labelled positive and
-- ZERO labelled negatives — no row anywhere carries location_mocked =
-- false. There is no known-clean session to measure against, so no false
-- positive rate can be computed. The 14.6% figure from backtesting is a
-- FLAG RATE against mostly-unlabelled sessions. It is not an FP rate and
-- must not be presented as one.

CREATE TABLE IF NOT EXISTS location_integrity_flags (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Scope. shift_session_id is the review unit; guard/site denormalised so
  -- the admin list needs no joins on a cold path.
  shift_session_id  UUID        NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
  guard_id          UUID        NOT NULL REFERENCES guards(id),
  site_id           UUID        NOT NULL REFERENCES sites(id),

  -- Which check fired: 'monotonicity_violation' | 'accuracy_sentinel'.
  -- Deliberately a plain varchar, not an enum — adding a check must not
  -- require a migration.
  check_name        VARCHAR(48) NOT NULL,

  -- The evidence, as raw values. Stored so a reviewer never has to trust
  -- the job's arithmetic: coordinate as submitted, the accuracy that was
  -- recorded, and the timestamps that make the violation visible.
  evidence          JSONB       NOT NULL,

  -- When the job observed it, and the window it covered.
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_event_at    TIMESTAMPTZ,
  last_event_at     TIMESTAMPTZ,

  -- Review state. A resolved flag STAYS resolved: the nightly job must not
  -- resurrect a row a human already dismissed (see the unique index below).
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       UUID,
  review_outcome    VARCHAR(24),          -- 'dismissed' | 'confirmed' | 'escalated'
  review_note       TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (session, check). The nightly job upserts with DO NOTHING, so
-- a re-run never duplicates and never overwrites review state.
CREATE UNIQUE INDEX IF NOT EXISTS uq_location_integrity_session_check
  ON location_integrity_flags (shift_session_id, check_name);

-- Admin list: unreviewed first, newest first.
CREATE INDEX IF NOT EXISTS idx_location_integrity_open
  ON location_integrity_flags (detected_at DESC)
  WHERE reviewed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_location_integrity_guard
  ON location_integrity_flags (guard_id, detected_at DESC);

COMMENT ON TABLE location_integrity_flags IS
  'ADVISORY review queue. Never consulted on a request path, never blocks a write, never shown to a guard. Written by a nightly job.';
COMMENT ON COLUMN location_integrity_flags.check_name IS
  'monotonicity_violation (primary, mechanism-independent) | accuracy_sentinel (secondary, detects one tool only).';
COMMENT ON COLUMN location_integrity_flags.evidence IS
  'Raw values behind the flag — coordinate, accuracy, timestamps — so a reviewer can verify without re-running the job.';
COMMENT ON COLUMN location_integrity_flags.review_outcome IS
  'dismissed | confirmed | escalated. Once reviewed_at is set the nightly job leaves the row alone.';

-- NO retention/expires_at column, deliberately: this is a review record,
-- not captured evidence. It holds no coordinates a guard did not already
-- submit elsewhere, and it must survive long enough to show that a flag was
-- looked at and dismissed.
--
-- NOT DONE HERE: no enforcement, no threshold, no blocking path, no change
-- to validateAtSite, no change to any request handler.
