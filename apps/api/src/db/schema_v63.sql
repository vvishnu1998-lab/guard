-- schema_v63 — push-device table, EXPAND half.
--
-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  SAFE TO APPLY BEFORE THE CODE DEPLOY. THAT IS THE POINT.             ║
-- ║                                                                       ║
-- ║  This file only ADDS: a table nothing writes yet, two indexes on that ║
-- ║  table, a trigger that fires only on changes to that table, and a     ║
-- ║  one-shot backfill. guards.fcm_token is NOT dropped and NOT rewritten ║
-- ║  by this file. The currently-deployed server keeps reading and        ║
-- ║  writing that column exactly as it does today, so applying this and   ║
-- ║  then letting it soak changes no observable behaviour.                ║
-- ║                                                                       ║
-- ║  The REVERSE order is the catastrophic one. If the P3 code ships      ║
-- ║  before this file is applied, every push-token write path throws      ║
-- ║  'relation "guard_devices" does not exist' — including the UPDATE     ║
-- ║  inside the login handler (routes/auth.ts:209). Not degraded push:    ║
-- ║  no guard on any tenant can sign in. Schema first, always.            ║
-- ║                                                                       ║
-- ║  Dropping guards.fcm_token is v64, a later phase, and only after the  ║
-- ║  18 read sites move off the column.                                   ║
-- ╚═══════════════════════════════════════════════════════════════════════╝
--
-- WHY THIS TABLE EXISTS
--
-- guards.fcm_token is a single nullable TEXT column on the guard row, with no
-- uniqueness of any kind. A device's push token is therefore COPIED onto every
-- guard row that device has ever logged into, and is never removed from the
-- previous one. Nothing repoints it and nothing detects the duplication. On
-- 2026-08-31 that delivered a STARNET guard's missed-ping, location-ping,
-- activity-report and clock-out notifications to a handset logged into a
-- different guard on a different tenant, while the guard on shift missed all
-- ten of his ping windows. The condition recurred on 2026-09-01 within hours
-- of clearing, across two tenants, on three guard rows at once.
--
-- The fix is the per-token uniqueness below. It is what turns "claiming a
-- token repoints it" from a convention nobody enforces into an invariant the
-- database will not let you violate.
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through piped
-- psql is a silent no-op in autocommit (learned applying v54, re-confirmed
-- applying v62). Migrations do NOT run on deploy — apps/api/railway.json runs
-- `node dist/index.js` and src/index.ts has no migrate call — so appending
-- this file to migrate.ts applies nothing by itself.

SET LOCAL lock_timeout = '3s';

-- ── The table ───────────────────────────────────────────────────────────
--
-- revoked_at NULL means active. Rows are REVOKED, never deleted, because the
-- absence of exactly this history is what forced the 2026-08-31 investigation
-- to proceed by inference: guards.fcm_token carries no timestamp, no prior
-- value and no reason, so "when did this token get here, and from where" was
-- unanswerable from the database. revoked_reason makes the common questions
-- answerable without a forensic reconstruction.
CREATE TABLE IF NOT EXISTS guard_devices (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  guard_id       UUID        NOT NULL REFERENCES guards(id) ON DELETE CASCADE,
  push_token     TEXT        NOT NULL,
  platform       VARCHAR(16),          -- 'ios' | 'android' | NULL when unknown
  client         TEXT,                 -- X-NetraOps-Client at claim time
  claimed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ,          -- NULL = active
  revoked_reason VARCHAR(24),
  CONSTRAINT chk_guard_devices_platform
    CHECK (platform IS NULL OR platform IN ('ios', 'android')),
  CONSTRAINT chk_guard_devices_revoked_reason
    CHECK (revoked_reason IS NULL OR revoked_reason IN
           ('logout', 'stale', 'repointed', 'password_change', 'admin_revoke')),
  -- A revoked row must say why, and a row with a reason must be revoked.
  -- Without this the 'stale' cleanup and the 'logout' path can each half-write
  -- a row that reads as active in one column and dead in the other.
  CONSTRAINT chk_guard_devices_revoked_pair
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- ── The two constraints that carry the whole design ─────────────────────
--
-- ONE ACTIVE DEVICE PER GUARD. The locked product decision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_guard_devices_one_active_per_guard
  ON guard_devices (guard_id) WHERE revoked_at IS NULL;

-- ONE ACTIVE GUARD PER DEVICE. This is the one the old schema lacked in every
-- form, and it is what the incident reduces to. It has a second payoff: with
-- it, push_token alone identifies at most one active device, so the
-- DeviceNotRegistered cleanup can revoke BY TOKEN without knowing the guard.
-- That is what lets the cleanup move into sendPushNotification and cover all
-- 18 dispatch sites instead of the 7 that hand-roll it today (P3).
CREATE UNIQUE INDEX IF NOT EXISTS uq_guard_devices_one_active_per_token
  ON guard_devices (push_token) WHERE revoked_at IS NULL;

-- History lookups: "every device this guard has ever claimed, newest first".
CREATE INDEX IF NOT EXISTS idx_guard_devices_guard_history
  ON guard_devices (guard_id, claimed_at DESC);

-- ── The mirror trigger ──────────────────────────────────────────────────
--
-- guards.fcm_token becomes a DERIVED column: the push_token of the guard's one
-- active device, or NULL. Because uq_guard_devices_one_active_per_guard
-- guarantees at most one such row, the scalar subquery below is total — it
-- yields exactly one value or NULL, never "which one?".
--
-- This exists so the 18 READ sites need zero edits. Reads outnumber writes
-- 18 to 11, so mirroring the column is a smaller and safer diff than
-- rewriting every dispatcher, and it lets P3 touch only the write paths.
-- The mirror is transitional: v64 drops it once the reads move.
--
-- It also means the column must have exactly one writer from P3 onward — this
-- trigger. A stray direct UPDATE of guards.fcm_token will desync silently
-- until the next guard_devices change for that guard. That is the known cost
-- of the smaller diff, and the reason v64 should not be left indefinitely.
--
-- Handles a guard_id change on UPDATE (resyncing both the old and the new
-- guard) even though the P3 repoint is revoke-then-insert and never moves a
-- row between guards. Cheap, and it means the mirror cannot be wrong if some
-- later path does move one.
CREATE OR REPLACE FUNCTION guard_devices_sync_mirror() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE guards g
       SET fcm_token = (SELECT d.push_token FROM guard_devices d
                         WHERE d.guard_id = OLD.guard_id AND d.revoked_at IS NULL)
     WHERE g.id = OLD.guard_id;
  END IF;

  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.guard_id IS DISTINCT FROM OLD.guard_id) THEN
    UPDATE guards g
       SET fcm_token = (SELECT d.push_token FROM guard_devices d
                         WHERE d.guard_id = NEW.guard_id AND d.revoked_at IS NULL)
     WHERE g.id = NEW.guard_id;
  END IF;

  RETURN NULL;  -- AFTER trigger; return value is ignored
END $$;

-- CREATE TRIGGER has no IF NOT EXISTS in PG14, so drop-then-create is how this
-- file stays replay-safe.
DROP TRIGGER IF EXISTS trg_guard_devices_sync_mirror ON guard_devices;
CREATE TRIGGER trg_guard_devices_sync_mirror
AFTER INSERT OR UPDATE OR DELETE ON guard_devices
FOR EACH ROW EXECUTE FUNCTION guard_devices_sync_mirror();

-- ── One-shot backfill ───────────────────────────────────────────────────
--
-- THE `NOT EXISTS (SELECT 1 FROM guard_devices)` TERM IS LOAD-BEARING AND MUST
-- NOT BE REMOVED. migrate.ts replays the ENTIRE chain on every run, so without
-- it this INSERT re-runs on every future `db:migrate`. It is a constant
-- subquery evaluated against the statement-start snapshot, so it gates the
-- whole statement, not row by row.
--
-- Both failure modes of an ungated replay were measured, not assumed, and
-- WHICH ONE you get depends on the mix of rows at replay time:
--
--   * Any guard that still has an ACTIVE device would be handed a second one,
--     so uq_guard_devices_one_active_per_guard raises 23505 and the ENTIRE
--     statement aborts — which in a chain run aborts migrate.ts and blocks
--     every migration after this one. Loud, and it blocks the chain.
--
--   * Any guard whose device was REVOKED (logout, staleness, repoint) but
--     whose guards.fcm_token was written back directly — which the old,
--     still-deployed server does on every login for the whole soak window —
--     has no active row to collide with. That one is re-inserted as ACTIVE,
--     the mirror repopulates, and all 18 dispatchers resume sending to a
--     handset that had been deliberately unregistered. Silent, and it
--     re-arms the exact defect this migration exists to fix.
--
-- If the eligible set happens to contain only the second kind, nothing raises
-- and the resurrection commits. Do not rely on the unique index to catch this;
-- it only catches the first kind.
--
-- WHAT IS CARRIED, AND WHAT IS DELIBERATELY NOT:
--
--   * unshared token on an active guard  -> carried.
--
--   * SHARED token (two or more guard rows hold the same value) -> NONE of
--     them is carried. Not most-recent-wins. A shared token is BY DEFINITION a
--     row whose device attribution is unknown — that is precisely what the
--     incident is — and most-recent-wins would pick a winner from evidence
--     that is known to be corrupt. On 2026-09-01 it would have awarded the
--     shared token to a paying-tenant STARNET guard whose own Android had not
--     touched the account since the previous day, cementing a cross-tenant
--     misattribution under a uniqueness constraint that then makes it
--     authoritative. Dropping it costs those guards push until their next app
--     launch, when _layout.tsx re-registers within seconds — and that
--     re-registration is a CORRECT claim under the new constraints. The
--     in-app Alerts tab is unaffected either way: all 18 dispatchers write
--     their notifications row regardless of token state.
--
--   * inactive guard -> not carried. An account nobody can log into does not
--     get an active device row.
--
-- platform and client are left NULL rather than inferred. They could be
-- derived from the most recent auth_events.user_agent, but that is the
-- platform of the last LOGIN, not of the device that happens to hold the
-- token — and conflating "who logged in last" with "whose device this is" is
-- the precise error that produced the incident. A NULL that admits it does
-- not know beats a guess that looks like a fact. Both fields populate
-- correctly from P3 onward, at claim time, from the request that claims.
INSERT INTO guard_devices (guard_id, push_token, claimed_at, last_seen_at)
SELECT g.id,
       g.fcm_token,
       COALESCE(g.tokens_not_before, NOW()),
       COALESCE(g.tokens_not_before, NOW())
  FROM guards g
 WHERE g.fcm_token IS NOT NULL
   AND g.is_active
   AND NOT EXISTS (SELECT 1 FROM guards o
                    WHERE o.id <> g.id AND o.fcm_token = g.fcm_token)
   AND NOT EXISTS (SELECT 1 FROM guard_devices);

-- ── Report what the backfill did, and what it left behind ───────────────
--
-- The skipped rows keep their guards.fcm_token value. This file deliberately
-- does NOT null them: rewriting the column would be a behaviour change, and
-- the whole point of the expand half is that applying it changes nothing
-- observable. The consequence is worth stating out loud rather than
-- discovering later — APPLYING THIS FILE DOES NOT STOP AN IN-FLIGHT CROSS-
-- DELIVERY. A shared token keeps being read from the mirror column by all 18
-- dispatchers until either P3 converts the write paths or someone clears it
-- deliberately as a separate operation.
DO $$
DECLARE
  carried  BIGINT;
  shared   BIGINT;
  inactive BIGINT;
BEGIN
  SELECT count(*) INTO carried FROM guard_devices WHERE revoked_at IS NULL;

  SELECT count(*) INTO shared FROM guards g
   WHERE g.fcm_token IS NOT NULL
     AND EXISTS (SELECT 1 FROM guards o WHERE o.id <> g.id AND o.fcm_token = g.fcm_token);

  SELECT count(*) INTO inactive FROM guards g
   WHERE g.fcm_token IS NOT NULL AND NOT g.is_active
     AND NOT EXISTS (SELECT 1 FROM guards o WHERE o.id <> g.id AND o.fcm_token = g.fcm_token);

  RAISE NOTICE 'schema_v63: % active device row(s) present.', carried;
  RAISE NOTICE 'schema_v63: % guard row(s) hold a SHARED token and were not carried — '
               'their guards.fcm_token is untouched and still dispatches.', shared;
  RAISE NOTICE 'schema_v63: % inactive guard(s) with an unshared token were not carried.', inactive;
END $$;

COMMENT ON TABLE guard_devices IS
  'One row per push-token claim. revoked_at IS NULL means active; the two partial unique indexes enforce one active device per guard and one active guard per device, which is what makes claiming a token REPOINT it rather than duplicate it. Rows are revoked, not deleted, so device history survives.';

COMMENT ON COLUMN guards.fcm_token IS
  'DERIVED from schema_v63 — the push_token of the guard''s one active guard_devices row, or NULL. Maintained solely by trigger trg_guard_devices_sync_mirror. Do not UPDATE this column directly; write to guard_devices instead. Transitional: dropped in schema_v64 once the 18 read sites move off it.';
