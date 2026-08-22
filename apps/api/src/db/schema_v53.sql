-- schema_v53 — offline dead-letter escalation (2026-08-22)
--
-- ── WHY THIS TABLE EXISTS ───────────────────────────────────────────────
--
-- The mobile offline queue moves an undeliverable action to a device-local
-- dead-letter bucket. From the day that queue shipped until 2026-08-22
-- NOTHING READ THAT BUCKET — no screen, no count, no server record. The
-- guard had already been shown "saved and will sync automatically", so a
-- lost patrol scan, report or task completion simply ceased to exist.
--
-- A device-only fix is not enough. If the guard ignores the banner,
-- dismisses it, or reinstalls the app, the loss is still invisible to
-- everyone upstream. This table is where a loss becomes admin-visible.
--
-- ── WHAT A ROW MEANS ────────────────────────────────────────────────────
--
-- "A guard's device attempted this write, was told it had been saved, and
-- it never landed." It is a record of a FAILURE, not of an event that
-- happened at the site. The payload is what the device tried to send; none
-- of it was ever validated by the API, so it must never be read as though
-- it were a real scan/report row.
--
-- ── WHAT IT IS NOT ──────────────────────────────────────────────────────
--
-- Not evidence of misconduct. The overwhelmingly likely cause is poor
-- connectivity, which is a property of the building, not the guard. Any
-- admin UI built on this must read as "these did not make it", never as
-- an accusation.
--
-- Additive, nullable where it can be, no destructive change. Safe to
-- re-run: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS offline_dead_letters (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Client-assigned uuid from the queue item. The idempotency key: the
  -- escalation sweep retries until acknowledged, so the same item WILL be
  -- posted more than once and must not create duplicate rows.
  -- VARCHAR rather than UUID deliberately — a malformed id from an old
  -- build must not 500 the endpoint.
  local_id      VARCHAR(64) NOT NULL,

  -- ALWAYS req.user.sub, NEVER a value from the request body. A guard
  -- cannot file a loss on behalf of another guard.
  guard_id      UUID NOT NULL REFERENCES guards(id) ON DELETE CASCADE,

  -- Resolved server-side from guards.company_id at insert time, so the row
  -- records the tenant as it stood when the loss was reported. The admin
  -- list still scopes by joining guards, matching location_integrity_flags.
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  action_type   VARCHAR(40) NOT NULL,   -- report_submit | checkpoint_scan | ...
  dead_reason   VARCHAR(24) NOT NULL,   -- permanent_4xx | max_attempts | unknown_type
  dead_status   INTEGER,                -- HTTP status, when there was one

  queued_at     TIMESTAMPTZ,            -- when the guard performed the action
  dead_at       TIMESTAMPTZ,            -- when the device gave up
  last_error    TEXT,                   -- diagnostic; never shown to a guard

  -- What the device tried to send. Coordinates, photo urls, notes.
  payload       JSONB,

  -- X-NetraOps-Client, so a loss is attributable to a build without
  -- guessing. Establishing which runtime one device was on cost a full
  -- session of forensics on 2026-08-21.
  client        VARCHAR(200),

  reported_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Admin review state, mirroring location_integrity_flags.
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   UUID,
  review_note   TEXT
);

-- Idempotency. Scoped per guard: local_id is Math.random-derived, so
-- collision across devices is vanishingly unlikely but not impossible, and
-- one guard's replay must never collide with another's.
CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_dead_letters_guard_local
  ON offline_dead_letters (guard_id, local_id);

-- Admin list: newest first within a tenant, unreviewed first.
CREATE INDEX IF NOT EXISTS idx_offline_dead_letters_company_reported
  ON offline_dead_letters (company_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_offline_dead_letters_unreviewed
  ON offline_dead_letters (company_id, reported_at DESC)
  WHERE reviewed_at IS NULL;
