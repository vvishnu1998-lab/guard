-- Schema v44 — Checkpoint scanning (EXPAND phase, schema only)
--
--   ① site_checkpoints — one row per physical NFC/QR tag position at a
--      site. Rows are created unlinked (code_value/lat/lng NULL) and
--      completed atomically by the guard's linking scan; the CHECK
--      constraint forbids half-linked rows. radius_meters bounds the
--      scan-distance gate; sort_order is display-only — no sequence
--      enforcement in this phase.
--
--      UNIQUE (site_id, code_value): dedups a physical tag within a
--      site once linked. Plain UNIQUE (default NULLS DISTINCT) already
--      permits unlimited unlinked (NULL code_value) rows per site, so
--      no partial index is needed.
--
--   ② checkpoint_scans — one row per accepted scan. UNIQUE
--      (checkpoint_id, shift_session_id, round_window) is the
--      idempotency guarantee for duplicate/retried scans — a real
--      table constraint (ON CONFLICT target for the route layer), not
--      a bare index. round_window is the America/Los_Angeles
--      wall-clock hour floor stored as its UTC instant, computed
--      server-side at insert. distance_m persists the anchor distance
--      for the admin drift column. site_id/guard_id are denormalized
--      with bare FKs, matching the shift_sessions convention.
--
--      Retention follows the v33 expires_at/legal_hold pattern with
--      the matching partial-index form; expires_at is NOT NULL with a
--      365d default (activity tier, per services/retention.ts) so a
--      row can never dodge the purge scan. NOTE: nightlyPurge.ts runs
--      explicit per-table steps — a checkpoint_scans step lands with
--      the service-layer phase, not here.
--
--      No photo_url — customer confirmed scans only.
--
-- All DDL uses IF NOT EXISTS so the migrate.ts loop stays idempotent
-- across deploys.

CREATE TABLE IF NOT EXISTS site_checkpoints (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             UUID          NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  label               VARCHAR(120)  NOT NULL,
  code_value          VARCHAR(512),                    -- NULL until a guard links the tag
  code_type           VARCHAR(20),                     -- NULL until linked (qr, code128, ...)
  lat                 DOUBLE PRECISION,                -- NULL until linked
  lng                 DOUBLE PRECISION,                -- NULL until linked
  link_accuracy_m     DOUBLE PRECISION,                -- GPS accuracy at the linking scan
  linked_at           TIMESTAMPTZ,
  linked_by_guard_id  UUID          REFERENCES guards(id),
  radius_meters       INTEGER       NOT NULL DEFAULT 50,
  sort_order          INTEGER       NOT NULL DEFAULT 0, -- display only
  is_active           BOOLEAN       NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_site_checkpoints_site_code UNIQUE (site_id, code_value),
  CONSTRAINT chk_site_checkpoints_link_complete CHECK (
    (code_value IS NULL AND lat IS NULL AND lng IS NULL)
    OR (code_value IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL)
  ),
  CONSTRAINT chk_site_checkpoints_radius CHECK (radius_meters BETWEEN 10 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_site_checkpoints_site_active
  ON site_checkpoints (site_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS checkpoint_scans (
  id                UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id     UUID              NOT NULL REFERENCES site_checkpoints(id) ON DELETE CASCADE,
  shift_session_id  UUID              NOT NULL REFERENCES shift_sessions(id),
  guard_id          UUID              NOT NULL REFERENCES guards(id),   -- denormalized
  site_id           UUID              NOT NULL REFERENCES sites(id),    -- denormalized
  scanned_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  round_window      TIMESTAMPTZ       NOT NULL,  -- LA wall-clock hour floor as UTC instant,
                                                 -- computed server-side at insert
  scan_lat          DOUBLE PRECISION  NOT NULL,
  scan_lng          DOUBLE PRECISION  NOT NULL,
  accuracy_m        DOUBLE PRECISION,
  distance_m        DOUBLE PRECISION  NOT NULL,  -- distance from checkpoint anchor,
                                                 -- persisted for the admin drift column
  note              TEXT,
  expires_at        TIMESTAMPTZ       NOT NULL DEFAULT (NOW() + INTERVAL '365 days'),
                                                 -- RETENTION.ACTIVITY_REPORT_DAYS tier —
                                                 -- keep in sync with services/retention.ts
  legal_hold        BOOLEAN           NOT NULL DEFAULT false,
  CONSTRAINT uq_checkpoint_scans_round UNIQUE (checkpoint_id, shift_session_id, round_window)
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_scans_site_scanned_at
  ON checkpoint_scans (site_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_checkpoint_scans_session_window
  ON checkpoint_scans (shift_session_id, round_window);

CREATE INDEX IF NOT EXISTS idx_checkpoint_scans_expires_at
  ON checkpoint_scans (expires_at) WHERE legal_hold = false;
