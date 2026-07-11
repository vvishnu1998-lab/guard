-- Schema v32 — Site scheduling profiles
--
-- A profile is a named weekly shift pattern owned by a site. Multiple
-- profiles per site are allowed (Regular / Holiday / Special Event etc.)
-- but only ONE can be active at a time — enforced by a unique partial
-- index on (site_id) WHERE is_active = true.
--
-- Rolling the pattern forward into concrete shifts stays a separate
-- action (existing SCHEDULE SHIFT modal). The profile is a *template*
-- + a *baseline* for the coverage-gap pill that lights up on the
-- Shifts tab.

CREATE TABLE IF NOT EXISTS site_scheduling_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  profile_name  VARCHAR(64) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_profile_shifts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         UUID NOT NULL REFERENCES site_scheduling_profiles(id) ON DELETE CASCADE,
  day_of_week        SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sunday
  shift_start_time   TIME NOT NULL,
  shift_length_hours NUMERIC(4,2) NOT NULL CHECK (shift_length_hours > 0 AND shift_length_hours <= 24),
  guards_needed      SMALLINT NOT NULL DEFAULT 1 CHECK (guards_needed BETWEEN 1 AND 10),
  active             BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_profile_shifts_profile
  ON site_profile_shifts (profile_id, day_of_week);

CREATE INDEX IF NOT EXISTS idx_scheduling_profiles_site
  ON site_scheduling_profiles (site_id, is_active);

-- Only one active profile per site. Update paths must deactivate the
-- current active row before flipping a new one, or wrap both in a
-- transaction using DEFERRABLE INITIALLY DEFERRED (not required here —
-- our writes always deactivate first).
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_profile_per_site
  ON site_scheduling_profiles (site_id)
  WHERE is_active = true;
