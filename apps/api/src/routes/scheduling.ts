import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

/**
 * Session S6 — Site scheduling profiles.
 *
 * Endpoints:
 *   GET    /api/scheduling/site/:siteId                  list profiles for a site
 *   POST   /api/scheduling/site/:siteId/profile          create profile + shifts
 *   PATCH  /api/scheduling/profile/:profileId            update profile / shifts
 *   DELETE /api/scheduling/profile/:profileId            delete (cascades to shifts)
 *   GET    /api/scheduling/site/:siteId/coverage-status  gap stats for a single site
 *   GET    /api/scheduling/coverage-status               gap stats for ALL sites in scope
 *                                                        (used by Shifts tab site cards)
 *
 * Auth: company_admin (own sites) OR vishnu (any site).
 *
 * Single-active-profile invariant is enforced by a partial unique index
 * (schema_v32). Writers that flip is_active always deactivate the current
 * one first, in the same transaction as the flip — the index will bite
 * otherwise.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM_RE = /^\d{2}:\d{2}(:\d{2})?$/;

interface ShiftPatch {
  day_of_week:        number;
  shift_start_time:   string;    // HH:MM or HH:MM:SS
  shift_length_hours: number;
  guards_needed?:     number;
  active?:            boolean;
}

// ── Scope helpers ────────────────────────────────────────────────────────

async function siteInScope(siteId: string, companyId: string | undefined, isVishnu: boolean) {
  if (!UUID_RE.test(siteId)) return null;
  if (isVishnu) {
    const r = await pool.query('SELECT id FROM sites WHERE id = $1', [siteId]);
    return r.rows[0] ?? null;
  }
  const r = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [siteId, companyId],
  );
  return r.rows[0] ?? null;
}

async function profileInScope(profileId: string, companyId: string | undefined, isVishnu: boolean) {
  if (!UUID_RE.test(profileId)) return null;
  if (isVishnu) {
    const r = await pool.query(
      'SELECT id, site_id, is_active FROM site_scheduling_profiles WHERE id = $1',
      [profileId],
    );
    return r.rows[0] ?? null;
  }
  const r = await pool.query(
    `SELECT p.id, p.site_id, p.is_active
       FROM site_scheduling_profiles p
       JOIN sites s ON s.id = p.site_id
      WHERE p.id = $1 AND s.company_id = $2`,
    [profileId, companyId],
  );
  return r.rows[0] ?? null;
}

// Reusable — validates + normalises a shifts[] input from client bodies.
// Throws with a helpful message on any malformed row.
function validateShifts(shifts: unknown): ShiftPatch[] {
  if (!Array.isArray(shifts)) throw new Error('shifts must be an array');
  return shifts.map((raw, idx) => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`shifts[${idx}] must be an object`);
    const s = raw as Record<string, unknown>;
    const day = Number(s.day_of_week);
    if (!Number.isInteger(day) || day < 0 || day > 6)          throw new Error(`shifts[${idx}].day_of_week must be 0-6`);
    if (typeof s.shift_start_time !== 'string' || !HHMM_RE.test(s.shift_start_time)) {
      throw new Error(`shifts[${idx}].shift_start_time must be HH:MM`);
    }
    const length = Number(s.shift_length_hours);
    if (!Number.isFinite(length) || length <= 0 || length > 24) throw new Error(`shifts[${idx}].shift_length_hours must be > 0 and <= 24`);
    const guards = s.guards_needed !== undefined ? Number(s.guards_needed) : 1;
    if (!Number.isInteger(guards) || guards < 1 || guards > 10) throw new Error(`shifts[${idx}].guards_needed must be 1-10`);
    const active = s.active !== undefined ? Boolean(s.active) : true;
    return { day_of_week: day, shift_start_time: s.shift_start_time, shift_length_hours: length, guards_needed: guards, active };
  });
}

// ── Reads ────────────────────────────────────────────────────────────────

// GET /api/scheduling/site/:siteId — all profiles + their shift patterns.
router.get('/site/:siteId', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await siteInScope(req.params.siteId, req.user!.company_id, isVishnu);
  if (!scope) return res.status(isVishnu ? 404 : 403).json({ error: 'Site not found' });

  const profiles = await pool.query(
    `SELECT id, site_id, profile_name, is_active, created_at, updated_at
       FROM site_scheduling_profiles
      WHERE site_id = $1
      ORDER BY is_active DESC, LOWER(profile_name) ASC`,
    [req.params.siteId],
  );
  if (profiles.rows.length === 0) return res.json({ profiles: [] });

  const shifts = await pool.query(
    `SELECT id, profile_id, day_of_week, shift_start_time, shift_length_hours, guards_needed, active
       FROM site_profile_shifts
      WHERE profile_id = ANY($1::uuid[])
      ORDER BY day_of_week ASC, shift_start_time ASC`,
    [profiles.rows.map((p) => p.id)],
  );
  const byProfile = new Map<string, any[]>();
  for (const s of shifts.rows) {
    if (!byProfile.has(s.profile_id)) byProfile.set(s.profile_id, []);
    byProfile.get(s.profile_id)!.push({
      id:                 s.id,
      day_of_week:        s.day_of_week,
      shift_start_time:   s.shift_start_time,
      shift_length_hours: Number(s.shift_length_hours),
      guards_needed:      s.guards_needed,
      active:             s.active,
    });
  }
  res.json({
    profiles: profiles.rows.map((p) => ({
      id:           p.id,
      site_id:      p.site_id,
      profile_name: p.profile_name,
      is_active:    p.is_active,
      created_at:   p.created_at,
      updated_at:   p.updated_at,
      shifts:       byProfile.get(p.id) ?? [],
    })),
  });
});

// ── Writes ───────────────────────────────────────────────────────────────

// POST /api/scheduling/site/:siteId/profile — create a profile + shifts.
// Body: { profile_name, is_active?, shifts: [...] }
router.post('/site/:siteId/profile', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await siteInScope(req.params.siteId, req.user!.company_id, isVishnu);
  if (!scope) return res.status(isVishnu ? 404 : 403).json({ error: 'Site not found' });

  const { profile_name, is_active: rawActive, shifts: rawShifts } = req.body ?? {};
  if (typeof profile_name !== 'string' || profile_name.trim().length < 2) {
    return res.status(400).json({ error: 'profile_name is required (min 2 chars)' });
  }
  const isActive = rawActive === undefined ? true : Boolean(rawActive);
  let shifts: ShiftPatch[];
  try { shifts = validateShifts(rawShifts ?? []); }
  catch (e: any) { return res.status(400).json({ error: e.message }); }
  if (shifts.length === 0) return res.status(400).json({ error: 'shifts must have at least one entry' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isActive) {
      // Deactivate any current active profile for this site to preserve
      // the one-active-per-site invariant (partial unique index).
      await client.query(
        `UPDATE site_scheduling_profiles SET is_active = false, updated_at = NOW()
          WHERE site_id = $1 AND is_active = true`,
        [req.params.siteId],
      );
    }
    const created = await client.query(
      `INSERT INTO site_scheduling_profiles (site_id, profile_name, is_active)
       VALUES ($1, $2, $3)
       RETURNING id, site_id, profile_name, is_active, created_at, updated_at`,
      [req.params.siteId, profile_name.trim(), isActive],
    );
    const profile = created.rows[0];
    for (const s of shifts) {
      await client.query(
        `INSERT INTO site_profile_shifts
           (profile_id, day_of_week, shift_start_time, shift_length_hours, guards_needed, active)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [profile.id, s.day_of_week, s.shift_start_time, s.shift_length_hours, s.guards_needed ?? 1, s.active ?? true],
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ id: profile.id, site_id: profile.site_id, profile_name: profile.profile_name,
      is_active: profile.is_active, created_at: profile.created_at, updated_at: profile.updated_at, shifts });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /api/scheduling/profile/:profileId — update name/active/shifts.
// If `shifts` is present, it replaces the profile's shifts wholesale.
router.patch('/profile/:profileId', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await profileInScope(req.params.profileId, req.user!.company_id, isVishnu);
  if (!scope) return res.status(404).json({ error: 'Profile not found' });

  const { profile_name, is_active, shifts: rawShifts } = req.body ?? {};
  let nextShifts: ShiftPatch[] | undefined;
  if (rawShifts !== undefined) {
    try { nextShifts = validateShifts(rawShifts); }
    catch (e: any) { return res.status(400).json({ error: e.message }); }
    if (nextShifts.length === 0) return res.status(400).json({ error: 'shifts must have at least one entry' });
  }
  if (
    profile_name === undefined && is_active === undefined && nextShifts === undefined
  ) return res.status(400).json({ error: 'Nothing to update' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Deactivate any competing active profile first if we're turning
    // this one on. Skip if we're turning THIS one off — no conflict.
    if (is_active === true && scope.is_active !== true) {
      await client.query(
        `UPDATE site_scheduling_profiles SET is_active = false, updated_at = NOW()
          WHERE site_id = $1 AND is_active = true AND id <> $2`,
        [scope.site_id, req.params.profileId],
      );
    }

    const sets: string[]  = [];
    const params: unknown[] = [];
    if (profile_name !== undefined) {
      if (typeof profile_name !== 'string' || profile_name.trim().length < 2) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'profile_name must be at least 2 chars' });
      }
      params.push(profile_name.trim()); sets.push(`profile_name = $${params.length}`);
    }
    if (is_active !== undefined) {
      params.push(Boolean(is_active)); sets.push(`is_active = $${params.length}`);
    }
    sets.push(`updated_at = NOW()`);
    params.push(req.params.profileId);
    const updated = await client.query(
      `UPDATE site_scheduling_profiles SET ${sets.join(', ')}
        WHERE id = $${params.length}
       RETURNING id, site_id, profile_name, is_active, created_at, updated_at`,
      params,
    );

    if (nextShifts) {
      await client.query('DELETE FROM site_profile_shifts WHERE profile_id = $1', [req.params.profileId]);
      for (const s of nextShifts) {
        await client.query(
          `INSERT INTO site_profile_shifts
             (profile_id, day_of_week, shift_start_time, shift_length_hours, guards_needed, active)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [req.params.profileId, s.day_of_week, s.shift_start_time, s.shift_length_hours, s.guards_needed ?? 1, s.active ?? true],
        );
      }
    }

    await client.query('COMMIT');
    res.json({
      ...updated.rows[0],
      ...(nextShifts ? { shifts: nextShifts } : {}),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /api/scheduling/profile/:profileId — cascade removes shifts.
router.delete('/profile/:profileId', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await profileInScope(req.params.profileId, req.user!.company_id, isVishnu);
  if (!scope) return res.status(404).json({ error: 'Profile not found' });

  await pool.query('DELETE FROM site_scheduling_profiles WHERE id = $1', [req.params.profileId]);
  res.json({ success: true });
});

// ── Coverage status ──────────────────────────────────────────────────────
//
// Window: today 00:00 SITE-LOCAL through +14 days, half-open.
//
// required = SUM(guards_needed) over the active profile's slot rows × 2.
//   UNCHANGED, deliberately — see the note above the query. Each day-of-week
//   appears exactly twice in a day-aligned 14-day window, so the ×2 is not an
//   approximation; it reproduces the expansion exactly.
//
// filled   = SUM over expanded slots of LEAST(matching shifts, guards_needed).
//            Over-staffing a slot never inflates the total; the surplus shows
//            up in off_template instead.
// gaps     = required - filled.
// off_template = in-window shifts occupying a post whose scheduled_start
//            matches NO slot. This is what makes "10 shifts but 0 filled"
//            legible rather than alarming.
//
// This REPLACES a bare COUNT(*) that did no matching at all: a site scheduled
// entirely off-template read as fully covered. It also fixes two window bugs
// in the old count — `scheduled_start >= NOW()` excluded every in-progress
// shift (all 10 `active` rows in prod at the time of writing), and
// `status <> 'cancelled'` counted `unassigned` rows, which have nobody on post.

/** Site-local window bounds, returned so the UI never has to guess. */
interface CoverageWindow { from: string; to: string }

async function computeCoverage(siteIds: string[]): Promise<Array<{
  site_id: string;
  has_active_profile: boolean;
  has_slots: boolean;
  required: number;
  filled: number;
  gaps: number;
  off_template: number;
  window: CoverageWindow | null;
}>> {
  if (siteIds.length === 0) return [];
  // Aggregate required from the active profiles.
  //
  // DO NOT REWRITE THIS TO COUNT EXPANDED SLOTS. It was verified against the
  // expansion at every profiled site (10 / 24 / 18) and against DST-spanning
  // windows: a day-aligned 14-day window contains exactly two of each
  // day-of-week, always, because DST changes a day's DURATION and never the
  // COUNT of calendar days. The ×2 is exact, and the two forms must agree or
  // `gaps` stops being `required - filled`.
  const requiredRows = await pool.query<{ site_id: string; required: string }>(
    `SELECT p.site_id,
            COALESCE(SUM(CASE WHEN sh.active THEN sh.guards_needed ELSE 0 END), 0) * 2 AS required
       FROM site_scheduling_profiles p
       LEFT JOIN site_profile_shifts sh ON sh.profile_id = p.id
      WHERE p.site_id = ANY($1::uuid[]) AND p.is_active = true
      GROUP BY p.site_id`,
    [siteIds],
  );
  const requiredMap = new Map<string, number>();
  for (const r of requiredRows.rows) requiredMap.set(r.site_id, Number(r.required));

  // Expansion + match + off-template, one query.
  //
  // ── The site-local window ────────────────────────────────────────────
  // d0 is today's SITE-LOCAL calendar date, and the 14 days are generated in
  // DATE space. Never `timestamptz + INTERVAL '14 days'`: the session
  // TimeZone is Etc/UTC, so interval-day arithmetic on an instant would land
  // on a different site wall-clock across a DST transition.
  //
  // ── The wall-clock -> instant conversion ─────────────────────────────
  // `(date + time)::timestamp AT TIME ZONE tz` is the same round-trip
  // services/tasks.ts:73 uses for task due_at, and the same idiom
  // routes/shifts.ts binds when it INSERTs a shift from a date + a time. The
  // slot instants therefore land on exactly the values a shift created for
  // that slot would carry — which is what makes exact-instant matching valid.
  //
  // Duration is added to the INSTANT, not to the wall clock, so a 6h slot is
  // 6 real hours even across a transition.
  //
  // ⚠ TWO DST HAZARDS, MEASURED, NOT FIXED HERE. Neither fires in a window
  // that does not contain a US transition; the first to bite is the window
  // opening 2026-10-19 (fall-back 2026-11-01), then 2027-03-14.
  //   1. SPRING FORWARD: a nonexistent local time does NOT raise. Postgres
  //      maps it forward, so a 02:30 slot and a 03:30 slot on 2027-03-14
  //      both resolve to 2027-03-14T10:30Z — one shift would satisfy both.
  //   2. FALL BACK: the ambiguous hour resolves to the LATER (standard-time)
  //      instant — 2026-11-01 01:30 -> 09:30Z, not 08:30Z. A shift genuinely
  //      created at the first 01:30 will not match its slot.
  // Both need a decision about what a slot MEANS on a transition day, which
  // is a product question, not a formatting one. Filed as an open item.
  //
  // ── Grouping ─────────────────────────────────────────────────────────
  // Slots are grouped by (site_id, slot_start) with guards_needed SUMMED.
  // There is no unique constraint on (profile_id, day_of_week,
  // shift_start_time), so two rows may describe the same instant; summing is
  // the only reading consistent with `required`, which sums every row.
  const slotRows = await pool.query<{
    site_id: string; slot_count: string; filled: string;
    off_template: string; win_from: Date; win_to: Date;
  }>(
    `WITH bounds AS (
       SELECT s.id AS site_id,
              s.timezone AS tz,
              (now() AT TIME ZONE s.timezone)::date AS d0
         FROM sites s
        WHERE s.id = ANY($1::uuid[])
     ),
     win AS (
       SELECT b.*,
              (b.d0)::timestamp      AT TIME ZONE b.tz AS win_from,
              (b.d0 + 14)::timestamp AT TIME ZONE b.tz AS win_to
         FROM bounds b
     ),
     slots AS (
       SELECT w.site_id,
              (((w.d0 + n)::date + ps.shift_start_time)::timestamp AT TIME ZONE w.tz) AS slot_start,
              SUM(ps.guards_needed)::int AS guards_needed
         FROM win w
         CROSS JOIN generate_series(0, 13) AS n
         JOIN site_scheduling_profiles p ON p.site_id = w.site_id AND p.is_active = true
         JOIN site_profile_shifts ps     ON ps.profile_id = p.id  AND ps.active = true
        WHERE EXTRACT(DOW FROM (w.d0 + n)::date)::int = ps.day_of_week
        GROUP BY w.site_id, slot_start
     ),
     occupied AS (
       SELECT sh.site_id, sh.scheduled_start
         FROM shifts sh
         JOIN win w ON w.site_id = sh.site_id
        WHERE sh.status NOT IN ('cancelled', 'unassigned')
          AND sh.scheduled_start >= w.win_from
          AND sh.scheduled_start <  w.win_to
     ),
     slot_fill AS (
       SELECT sl.site_id, sl.slot_start, sl.guards_needed,
              COUNT(o.scheduled_start) AS matches
         FROM slots sl
         LEFT JOIN occupied o
                ON o.site_id = sl.site_id AND o.scheduled_start = sl.slot_start
        GROUP BY sl.site_id, sl.slot_start, sl.guards_needed
     )
     SELECT w.site_id,
            w.win_from,
            w.win_to,
            COALESCE((SELECT COUNT(*)                              FROM slot_fill f WHERE f.site_id = w.site_id), 0) AS slot_count,
            COALESCE((SELECT SUM(LEAST(f.matches, f.guards_needed)) FROM slot_fill f WHERE f.site_id = w.site_id), 0) AS filled,
            COALESCE((SELECT COUNT(*) FROM occupied o
                       WHERE o.site_id = w.site_id
                         AND NOT EXISTS (SELECT 1 FROM slots sl
                                          WHERE sl.site_id = o.site_id
                                            AND sl.slot_start = o.scheduled_start)), 0) AS off_template
       FROM win w`,
    [siteIds],
  );
  const slotMap = new Map<string, {
    slotCount: number; filled: number; offTemplate: number; from: Date; to: Date;
  }>();
  for (const r of slotRows.rows) {
    slotMap.set(r.site_id, {
      slotCount:   Number(r.slot_count),
      filled:      Number(r.filled),
      offTemplate: Number(r.off_template),
      from:        r.win_from,
      to:          r.win_to,
    });
  }

  return siteIds.map((siteId) => {
    const hasProfile = requiredMap.has(siteId);
    const required   = requiredMap.get(siteId) ?? 0;
    const agg        = slotMap.get(siteId);

    // With no active profile there is nothing to be off-template FROM, so the
    // counts are suppressed rather than reported against an empty template —
    // every shift at the site would otherwise read as off-template.
    const filled      = hasProfile ? (agg?.filled      ?? 0) : 0;
    const offTemplate = hasProfile ? (agg?.offTemplate ?? 0) : 0;

    return {
      site_id:            siteId,
      has_active_profile: hasProfile,
      // An active profile whose slot rows are all inactive (or absent) is
      // "no slots configured", NOT "fully covered". required is 0 in that
      // case, so gaps would be 0 and the old code rendered the green pill.
      has_slots:          hasProfile && (agg?.slotCount ?? 0) > 0,
      required,
      filled,
      gaps:               Math.max(0, required - filled),
      off_template:       offTemplate,
      window: agg ? { from: agg.from.toISOString(), to: agg.to.toISOString() } : null,
    };
  });
}

// GET /api/scheduling/site/:siteId/coverage-status — one site.
router.get('/site/:siteId/coverage-status', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await siteInScope(req.params.siteId, req.user!.company_id, isVishnu);
  if (!scope) return res.status(isVishnu ? 404 : 403).json({ error: 'Site not found' });

  const [row] = await computeCoverage([req.params.siteId]);
  res.json(row);
});

// GET /api/scheduling/coverage-status — every site in the caller's scope.
// Used by the Shifts tab site cards to render the gap pill (single call,
// no N+1 fetch).
router.get('/coverage-status', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const siteRows = isVishnu
    ? await pool.query('SELECT id FROM sites')
    : await pool.query('SELECT id FROM sites WHERE company_id = $1', [req.user!.company_id]);
  const rows = await computeCoverage(siteRows.rows.map((r) => r.id));
  res.json(rows);
});

export default router;
