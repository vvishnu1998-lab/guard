import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { SLOT_EXPANSION_CTE, OCCUPIED_CTE } from '../services/slotExpansion';
import { findOverlappingShift } from '../services/shiftOverlap';
import { checkShiftEligibility, eligibilityError } from '../services/guardAssignments';
import { expiresAtFor } from '../services/retention';
import { pushShiftAssignments, type CreatedShift } from '../services/shiftPush';
import { clearScheduleDerivedLatches } from '../services/shiftLatches';

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
  // The expansion itself lives in services/slotExpansion.ts and is shared
  // verbatim with GET /site/:siteId/slots — a second spelling of the
  // AT TIME ZONE round-trip is exactly how two answers to one question get
  // created. Every note about the site-local window, the wall-clock
  // conversion, the two DST hazards and the (site_id, slot_start) grouping
  // lives there, at the code it describes.
  const slotRows = await pool.query<{
    site_id: string; slot_count: string; filled: string;
    off_template: string; win_from: Date; win_to: Date;
  }>(
    `WITH ${SLOT_EXPANSION_CTE},
     ${OCCUPIED_CTE},
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

// GET /api/scheduling/site/:siteId/slots — the expanded template as a LIST.
//
// Phase D. /coverage-status returns aggregates for every site in scope; this
// returns one row per slot for ONE site, which is a different question with a
// different payload size (a 15-site company would carry several hundred rows
// if this were folded into the bulk route).
//
// SLOT IDENTITY IS (site_id, slot_start), NEVER site_profile_shifts.id.
// PATCH /profile/:profileId DELETEs and re-INSERTs every slot row whenever a
// `shifts` payload is present (:250-259), so row ids do not survive a template
// edit — observed in production, not theorised: the SFMTA Sunday-08:00 row was
// 74c85cab-… on 2026-09-09 and 298fad29-… hours later, same day, same time,
// same guards_needed. slot_start is also exactly the scheduled_start a shift
// created for the slot will carry, so it is the natural key for an assign
// action as well as for display.
//
// matched_shift_ids   rows that OCCUPY the slot — these count toward `filled`.
// unassigned_shift_ids rows sitting at the same instant with status
//   'unassigned'. Phase B's `occupied` deliberately excludes those (nobody is
//   on post), which means such a row is invisible to both `filled` and
//   `off_template`. Surfacing it here lets an assign action PATCH the existing
//   row instead of creating a second one at the same instant.
router.get('/site/:siteId/slots', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await siteInScope(req.params.siteId, req.user!.company_id, isVishnu);
  if (!scope) return res.status(isVishnu ? 404 : 403).json({ error: 'Site not found' });

  // Deliberately NOT copying /coverage-status's missing is_active filter
  // (N53): a deactivated site cannot be scheduled, so returning its slots
  // would offer an assign action that POST /api/shifts rejects with a 409
  // ("Site is deactivated"). vishnu still sees them — that role's whole
  // purpose here is an audit surface — but a company_admin does not.
  const siteRow = await pool.query<{ is_active: boolean; timezone: string; name: string }>(
    'SELECT is_active, timezone, name FROM sites WHERE id = $1',
    [req.params.siteId],
  );
  const site = siteRow.rows[0];
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!site.is_active && !isVishnu) {
    return res.json({
      site_id: req.params.siteId, site_timezone: site.timezone,
      has_active_profile: false, has_slots: false, window: null, slots: [],
    });
  }

  // Asked separately, NOT inferred from slots.length. An active profile whose
  // slot rows are all inactive expands to zero slots, and collapsing that into
  // "no active profile" would erase the distinction /coverage-status is careful
  // to keep — "No slots configured" is a different sentence from rendering
  // nothing at all.
  const profileRow = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM site_scheduling_profiles WHERE site_id = $1 AND is_active = true
     ) AS exists`,
    [req.params.siteId],
  );
  const hasActiveProfile = profileRow.rows[0]?.exists === true;

  const { rows } = await pool.query<{
    slot_start: Date; slot_end: Date; guards_needed: number;
    filled: number; matched_shift_ids: string[]; unassigned_shift_ids: string[];
    win_from: Date; win_to: Date;
  }>(
    `WITH ${SLOT_EXPANSION_CTE},
     ${OCCUPIED_CTE},
     unassigned AS (
       SELECT sh.id, sh.site_id, sh.scheduled_start
         FROM shifts sh
         JOIN win w ON w.site_id = sh.site_id
        WHERE sh.status = 'unassigned'
          AND sh.scheduled_start >= w.win_from
          AND sh.scheduled_start <  w.win_to
     )
     SELECT sl.slot_start,
            sl.slot_end,
            sl.guards_needed,
            w.win_from,
            w.win_to,
            LEAST(COUNT(DISTINCT o.id), sl.guards_needed)::int AS filled,
            COALESCE(ARRAY_AGG(DISTINCT o.id) FILTER (WHERE o.id IS NOT NULL), '{}') AS matched_shift_ids,
            COALESCE(ARRAY_AGG(DISTINCT u.id) FILTER (WHERE u.id IS NOT NULL), '{}') AS unassigned_shift_ids
       FROM slots sl
       JOIN win w ON w.site_id = sl.site_id
       LEFT JOIN occupied   o ON o.site_id = sl.site_id AND o.scheduled_start = sl.slot_start
       LEFT JOIN unassigned u ON u.site_id = sl.site_id AND u.scheduled_start = sl.slot_start
      GROUP BY sl.slot_start, sl.slot_end, sl.guards_needed, w.win_from, w.win_to
      ORDER BY sl.slot_start`,
    [[req.params.siteId]],
  );

  res.json({
    site_id:            req.params.siteId,
    site_timezone:      site.timezone,
    has_active_profile: hasActiveProfile,
    has_slots:          rows.length > 0,
    window: rows[0]
      ? { from: rows[0].win_from.toISOString(), to: rows[0].win_to.toISOString() }
      : null,
    slots: rows.map((r) => ({
      slot_start:           r.slot_start.toISOString(),
      slot_end:             r.slot_end.toISOString(),
      guards_needed:        r.guards_needed,
      filled:               Number(r.filled),
      matched_shift_ids:    r.matched_shift_ids,
      unassigned_shift_ids: r.unassigned_shift_ids,
    })),
  });
});

// POST /api/scheduling/site/:siteId/slot-candidates — who can work THIS SET.
//
// Body: { slot_starts: ISO[] }
//
// POST FOR A READ, DELIBERATELY. This is a query whose input is a SET — up to
// one selection per slot in the window — and the locked behaviour is that the
// dropdown evaluates every guard against the WHOLE selection before the admin
// picks, so nobody is offered and then rejected. Putting 22 ISO instants in a
// query string works until it doesn't; the body is the honest place for a set.
// It writes nothing.
//
// EVERY GUARD IN THE COMPANY IS RETURNED, none filtered. An unavailable guard
// is greyed WITH THE REASON — filtering them out is what makes an admin ask
// "where is X?" and get no answer.
//
// ── TWO INTERVAL SEMANTICS, BOTH DELIBERATE, NEITHER RECONCILED HERE ─────
//
// They already coexist on POST /api/shifts and this endpoint must agree with
// that route or the dropdown would promise something the write path refuses.
//
//   ASSIGNMENT WINDOW — CLOSED, on CALENDAR DATES, site-local.
//     assigned_from <= d AND (assigned_until IS NULL OR assigned_until >= d)
//     Lifted from services/guardAssignments.ts:77-78. An assignment ending
//     2026-09-20 DOES cover a shift on 2026-09-20 — hence `<=` and `>=`. The
//     date is the slot's SITE-LOCAL calendar day, not a UTC day.
//
//   OVERLAP — HALF-OPEN, on INSTANTS.
//     sh.scheduled_start < slot_end AND sh.scheduled_end > slot_start
//     Lifted from services/shiftOverlap.ts:109-110. A shift ending exactly
//     when a slot begins does NOT overlap it — hence `<` and `>`. There is no
//     rest-gap rule: a guard is free the instant the prior shift ends.
//
// So one question is asked in days and the other in instants, and the
// operators differ for that reason rather than by oversight. Reconciling them
// is a separate decision affecting every write path.
router.post('/site/:siteId/slot-candidates', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await siteInScope(req.params.siteId, req.user!.company_id, isVishnu);
  if (!scope) return res.status(isVishnu ? 404 : 403).json({ error: 'Site not found' });

  const raw = (req.body as { slot_starts?: unknown })?.slot_starts;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(422).json({ error: 'slot_starts must be a non-empty array' });
  }
  if (raw.length > 200) {
    return res.status(422).json({ error: 'Too many slots — max 200' });
  }
  if (!raw.every((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)))) {
    return res.status(422).json({ error: 'slot_starts must be ISO timestamps' });
  }
  const slotStarts = raw as string[];

  // Guards are scoped to the SITE's company, not the caller's — vishnu has no
  // company_id of its own, and a guard from another tenant can never work here.
  const siteRow = await pool.query<{ company_id: string }>(
    'SELECT company_id FROM sites WHERE id = $1',
    [req.params.siteId],
  );
  const companyId = siteRow.rows[0]?.company_id;
  if (!companyId) return res.status(404).json({ error: 'Site not found' });

  const { rows } = await pool.query<{
    guard_id: string; name: string; badge_number: string; is_active: boolean;
    total: number; free_count: number; blocked: unknown;
  }>(
    `WITH ${SLOT_EXPANSION_CTE},
     -- Selected slots are RE-DERIVED from the expansion, never taken from the
     -- client. A slot_start that is not a real slot is silently dropped, so a
     -- stale selection cannot widen what gets evaluated.
     sel AS (
       SELECT sl.slot_start, sl.slot_end, w.tz
         FROM slots sl
         JOIN win w ON w.site_id = sl.site_id
        WHERE sl.slot_start = ANY($2::timestamptz[])
     ),
     cand AS (
       SELECT g.id, g.name, g.badge_number, g.is_active
         FROM guards g
        WHERE g.company_id = $3
     ),
     cell AS (
       SELECT c.id AS guard_id, c.name, c.badge_number, c.is_active,
              s.slot_start,
              CASE
                WHEN NOT c.is_active THEN 'guard_inactive'
                WHEN NOT EXISTS (
                  SELECT 1 FROM guard_site_assignments gsa
                   WHERE gsa.guard_id = c.id
                     AND gsa.site_id  = $1[1]
                     AND gsa.assigned_from <= (s.slot_start AT TIME ZONE s.tz)::date
                     AND (gsa.assigned_until IS NULL
                          OR gsa.assigned_until >= (s.slot_start AT TIME ZONE s.tz)::date)
                ) THEN 'not_assigned_to_site'
                WHEN cf.shift_id IS NOT NULL
                     AND cf.scheduled_start = s.slot_start
                     AND cf.site_id = $1[1] THEN 'already_on_slot'
                WHEN cf.shift_id IS NOT NULL THEN 'overlap'
                ELSE NULL
              END AS reason,
              cf.shift_id, cf.site_name, cf.scheduled_start, cf.scheduled_end
         FROM cand c
         CROSS JOIN sel s
         LEFT JOIN LATERAL (
           SELECT sh.id AS shift_id, sh.site_id, si2.name AS site_name,
                  sh.scheduled_start, sh.scheduled_end
             FROM shifts sh
             JOIN sites si2 ON si2.id = sh.site_id
            WHERE sh.guard_id = c.id
              AND sh.status IN ('scheduled','active')
              AND sh.scheduled_start < s.slot_end
              AND sh.scheduled_end   > s.slot_start
            ORDER BY sh.scheduled_start
            LIMIT 1
         ) cf ON true
     )
     SELECT guard_id, name, badge_number, is_active,
            COUNT(*)::int                                  AS total,
            COUNT(*) FILTER (WHERE reason IS NULL)::int     AS free_count,
            COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
              'slot_start', slot_start,
              'reason',     reason,
              'conflict',   CASE WHEN shift_id IS NULL THEN NULL ELSE JSON_BUILD_OBJECT(
                              'shift_id',        shift_id,
                              'site_name',       site_name,
                              'scheduled_start', scheduled_start,
                              'scheduled_end',   scheduled_end) END
            ) ORDER BY slot_start) FILTER (WHERE reason IS NOT NULL), '[]') AS blocked
       FROM cell
      GROUP BY guard_id, name, badge_number, is_active
      ORDER BY free_count DESC, name ASC`,
    [[req.params.siteId], slotStarts, companyId],
  );

  res.json({
    site_id:     req.params.siteId,
    slot_count:  slotStarts.length,
    candidates:  rows.map((r) => ({
      guard_id:     r.guard_id,
      name:         r.name,
      badge_number: r.badge_number,
      is_active:    r.is_active,
      total:        r.total,
      free_count:   r.free_count,
      blocked:      r.blocked,
    })),
  });
});

// POST /api/scheduling/site/:siteId/assign-slots — bulk assign, PARTIAL.
//
// Body: { guard_id, slots: [{ slot_start, guards_needed, filled }] }
//
// Per slot it decides PATCH or CREATE: PATCH when an `unassigned` row already
// sits at that instant (Phase B's `occupied` excludes those, so such a row is
// invisible to both `filled` and `off_template` — creating a second row beside
// it would silently double-book the post), CREATE otherwise.
//
// ── TRANSACTION SHAPE: NONE SHARED. ONE ATOMIC STATEMENT PER SLOT. ───────
//
// Partial success and a shared transaction are incompatible, and the failure
// mode is not academic — Phase C found `repeat_days` committing a partial
// series and returning 500 (N44). The inverse is worse: had every slot been
// written inside ONE transaction that a later slot's failure rolled back, this
// endpoint would have reported `assigned` for rows that no longer exist. The
// response would lie, and the UI would untick slots that were never created.
//
// So each slot's write is a SINGLE statement, its own implicit transaction:
//   CREATE  a conditional INSERT ... SELECT ... WHERE (capacity) RETURNING id
//   PATCH   an UPDATE guarded on `status = 'unassigned'` AND (capacity)
// A slot enters `assigned[]` only after its own statement returned a row.
// Nothing later can undo it, so the response is true by construction. A slot
// that fails leaves every earlier slot committed and does not touch any later
// one — which is exactly the locked behaviour: assign the three that work,
// leave the fourth ticked with its reason.
//
// An explicit BEGIN would buy nothing here. Each slot is one statement, and
// wrapping the read-checks with the write would NOT close the check-then-act
// race — that needs a lock on the candidate's other shift rows, or a GiST
// exclusion constraint. See N45; this phase does not close it.
//
// ── CAPACITY IS THE ONE RACE THIS DOES CLOSE ────────────────────────────
//
// `slot_full` is two admins taking the last opening on a "1 of 2". The count
// lives INSIDE the write statement rather than in a preceding SELECT, so the
// check and the insert are one atomic operation. Zero rows returned means
// somebody else took it between the read-checks and the write, and the caller
// is told `slot_full` rather than getting a third guard on a two-guard post.
router.post('/site/:siteId/assign-slots', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await siteInScope(req.params.siteId, req.user!.company_id, isVishnu);
  if (!scope) return res.status(isVishnu ? 404 : 403).json({ error: 'Site not found' });

  const body = req.body as {
    guard_id?: unknown;
    slots?: unknown;
  };
  if (typeof body?.guard_id !== 'string' || !UUID_RE.test(body.guard_id)) {
    return res.status(422).json({ error: 'guard_id must be a uuid' });
  }
  if (!Array.isArray(body.slots) || body.slots.length === 0) {
    return res.status(422).json({ error: 'slots must be a non-empty array' });
  }
  if (body.slots.length > 200) {
    return res.status(422).json({ error: 'Too many slots — max 200' });
  }
  const wanted = body.slots as Array<{ slot_start?: unknown; guards_needed?: unknown; filled?: unknown }>;
  if (!wanted.every((s) =>
    typeof s?.slot_start === 'string' && !Number.isNaN(Date.parse(s.slot_start)) &&
    Number.isInteger(s?.guards_needed) && Number.isInteger(s?.filled))) {
    return res.status(422).json({ error: 'each slot needs slot_start (ISO), guards_needed and filled' });
  }
  const guardId = body.guard_id;

  // Guard must be active and in the SITE's company. Checked once — a guard
  // does not become inactive between slots within one request, and if it does
  // the per-slot overlap/eligibility checks still run against live data.
  const siteRow = await pool.query<{ company_id: string; timezone: string }>(
    'SELECT company_id, timezone FROM sites WHERE id = $1', [req.params.siteId],
  );
  const site = siteRow.rows[0];
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const guardRow = await pool.query<{ is_active: boolean }>(
    'SELECT is_active FROM guards WHERE id = $1 AND company_id = $2',
    [guardId, site.company_id],
  );
  const guardOk = guardRow.rows[0]?.is_active === true;

  // Re-derive every slot from the shared expansion. slot-candidates answered
  // the eligibility question a moment ago and this endpoint does NOT trust
  // that answer: between the two calls a shift can land, an assignment window
  // can lapse, a guard can be deactivated, or the template can be edited —
  // and a template edit DELETEs and re-INSERTs every slot row (:250-259), so
  // "the slot I ticked" may simply no longer exist.
  const derived = await pool.query<{
    slot_start: Date; slot_end: Date; guards_needed: number; unassigned_id: string | null;
  }>(
    `WITH ${SLOT_EXPANSION_CTE}
     SELECT sl.slot_start, sl.slot_end, sl.guards_needed,
            -- The PATCH target. CANCEL CAN DESTROY IT: PATCH /shifts/:id/cancel
            -- admits status='unassigned', and a cancelled row no longer matches
            -- here, so the slot falls to the INSERT branch below and a fresh
            -- row is created instead of this one being reused. Nothing breaks -
            -- capacity counting excludes cancelled rows either way - but the
            -- shift id for that slot changes. The cancel route's docblock
            -- carries the full note.
            (SELECT sh.id FROM shifts sh
              WHERE sh.site_id = sl.site_id
                AND sh.scheduled_start = sl.slot_start
                AND sh.status = 'unassigned'
              ORDER BY sh.created_at
              LIMIT 1) AS unassigned_id
       FROM slots sl`,
    [[req.params.siteId]],
  );
  const bySlot = new Map(derived.rows.map((r) => [r.slot_start.toISOString(), r]));

  const assigned: Array<{ slot_start: string; shift_id: string; action: 'created' | 'patched' }> = [];
  const failed: Array<{ slot_start: string; reason: string; message: string; conflict?: unknown }> = [];
  const created: CreatedShift[] = [];

  for (const w of wanted) {
    const slotStart = new Date(w.slot_start as string).toISOString();
    const fail = (reason: string, message: string, conflict?: unknown) =>
      failed.push({ slot_start: slotStart, reason, message, ...(conflict ? { conflict } : {}) });

    if (!guardOk) {
      fail('guard_inactive', 'That guard is inactive or belongs to another company.');
      continue;
    }

    const slot = bySlot.get(slotStart);
    // Gone, or its shape moved underneath the selection. guards_needed is
    // compared because the client sent what it rendered — if the template was
    // edited between render and submit, assigning against stale arithmetic is
    // how a 1-guard post acquires two.
    if (!slot || slot.guards_needed !== w.guards_needed) {
      fail('template_changed',
        'The scheduling template changed while this was selected. Reload the slot list.');
      continue;
    }

    // Assignment window — CLOSED, site-local calendar date (guardAssignments).
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: site.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(slot.slot_start);
    const elig = await checkShiftEligibility(guardId, req.params.siteId, dateStr);
    if (!elig.ok) {
      fail('not_assigned_to_site', eligibilityError(elig, dateStr));
      continue;
    }

    // Already standing on THIS slot, checked before the general overlap.
    // findOverlappingShift would catch this guard anyway — their shift starts
    // exactly at slot_start, so the half-open predicate matches — but it would
    // report `overlap` and name the site, which reads as "busy elsewhere" and
    // sends the admin hunting a clash that is really "already here". It cannot
    // be derived from the helper's return either: OverlapConflict carries
    // site_name but not site_id, and another site's shift can legitimately
    // start at the same instant.
    const onThisSlot = await pool.query(
      `SELECT 1 FROM shifts
        WHERE guard_id = $1 AND site_id = $2
          AND scheduled_start = $3::timestamptz
          AND status IN ('scheduled','active')
        LIMIT 1`,
      [guardId, req.params.siteId, slotStart],
    );
    if (onThisSlot.rows[0]) {
      fail('already_on_slot', 'That guard is already assigned to this slot.');
      continue;
    }

    // Overlap — HALF-OPEN, instants (shiftOverlap). excludeShiftId is the
    // unassigned row we are about to PATCH, if any: it carries no guard_id, so
    // it cannot conflict with this guard — but excluding it costs nothing and
    // keeps the check correct if that ever changes.
    const conflict = await findOverlappingShift(
      guardId, slot.slot_start, slot.slot_end, slot.unassigned_id,
    );
    if (conflict) {
      fail('overlap',
        `${conflict.guard_name ?? 'That guard'} already has a shift at ${conflict.site_name} ` +
        `overlapping these hours.`,
        {
          shift_id:        conflict.shift_id,
          guard_name:      conflict.guard_name,
          site_name:       conflict.site_name,
          scheduled_start: conflict.scheduled_start,
          scheduled_end:   conflict.scheduled_end,
        });
      continue;
    }

    // ── The write. One statement, capacity checked inside it. ──────────
    if (slot.unassigned_id) {
      // THE PATCH PATH IS THREE WRITES, so it gets its own transaction —
      // per-SLOT, never shared across slots. That is fully compatible with
      // partial success: each slot commits or rolls back on its own, and a
      // slot still enters `assigned[]` only after ITS unit committed. What the
      // docblock rules out is one transaction spanning every slot, where a
      // later failure would retract successes already reported.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const upd = await client.query<{ id: string; guard_id: string; site_id: string;
          scheduled_start: Date; scheduled_end: Date }>(
          `UPDATE shifts
              SET guard_id = $1, status = 'scheduled'
            WHERE id = $2
              AND status = 'unassigned'
              AND (SELECT COUNT(*) FROM shifts x
                    WHERE x.site_id = $3 AND x.scheduled_start = $4::timestamptz
                      AND x.status NOT IN ('cancelled','unassigned')) < $5
          RETURNING id, guard_id, site_id, scheduled_start, scheduled_end`,
          [guardId, slot.unassigned_id, req.params.siteId, slotStart, slot.guards_needed],
        );
        if (!upd.rows[0]) {
          await client.query('ROLLBACK');
          fail('slot_full', 'That slot filled up while this was selected.');
          continue;
        }

        // Re-arm the reminder chain. An unassigned shift can still have
        // accumulated latches — every latch cron selects on status, and
        // missedShiftAlert/preShiftReminder do not require a guard to have
        // been assigned when they fired — so the incoming guard would
        // otherwise inherit spent reminders. Same call PATCH /:id/assign-guard
        // makes at shifts.ts:699. AFTER the update, not before: on the
        // slot_full path there is nothing to re-arm and no reason to write.
        await clearScheduleDerivedLatches(upd.rows[0].id, client);

        // AUDIT — shift_reassignments, matching shifts.ts:719-725 exactly.
        // This is the identical transition that route performs: a guard
        // assigned to a shift that had none, old_guard_id NULL (schema_v15
        // made it nullable for precisely this case). Two paths doing the same
        // thing must not disagree about whether it is recorded. `reason` is
        // NULL — bulk assign takes no per-slot note, and inventing text would
        // put words in the admin's mouth.
        await client.query(
          `INSERT INTO shift_reassignments
             (shift_id, old_guard_id, new_guard_id,
              reassigned_by_admin_id, reassigned_by_role, reason)
           VALUES ($1, NULL, $2, $3, $4, NULL)`,
          [upd.rows[0].id, guardId, req.user!.sub, req.user!.role],
        );

        await client.query('COMMIT');
        assigned.push({ slot_start: slotStart, shift_id: upd.rows[0].id, action: 'patched' });
        created.push(upd.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[scheduling.assign-slots] patch failed:', err);
        fail('write_failed', 'Could not assign that slot. Try again.');
      } finally {
        client.release();
      }
    } else {
      // source = 'profile', and this is the ONLY writer of that value.
      //
      // The row exists because the PROFILE says a slot exists here: slot_start
      // comes out of SLOT_EXPANSION_CTE over site_profile_shifts, not out of
      // anything a person typed. The other three INSERT sites (routes/shifts.ts
      // :300, :473, :528) are an admin filling in a form and stay 'manual'.
      //
      // THE PATCH BRANCH ABOVE DELIBERATELY DOES NOT TOUCH source. It reuses a
      // pre-existing status='unassigned' row that something else created, and
      // assigning a guard to a row does not change who created it. Rewriting
      // source there would be a backfill by another name — and backfill is
      // exactly what this column cannot support: template edits DELETE and
      // re-INSERT site_profile_shifts with no versioning (see the PATCH at
      // :257) and nothing audits them, so a row's historical provenance is
      // unrecoverable. Provenance is written once, by whoever creates.
      //
      // Nothing READS source yet. It was added by schema_v71 for this moment;
      // every one of the 527 production rows says 'manual' today, 512 of them
      // because that is the column DEFAULT rather than because anyone chose it.
      const ins = await pool.query<{ id: string; guard_id: string; site_id: string;
        scheduled_start: Date; scheduled_end: Date }>(
        `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, expires_at,
                             created_by, created_by_role, source)
         SELECT $1, $2, $3::timestamptz, $4::timestamptz, 'scheduled', $5, $6, $7, 'profile'
          WHERE (SELECT COUNT(*) FROM shifts x
                  WHERE x.site_id = $2 AND x.scheduled_start = $3::timestamptz
                    AND x.status NOT IN ('cancelled','unassigned')) < $8
         RETURNING id, guard_id, site_id, scheduled_start, scheduled_end`,
        [guardId, req.params.siteId, slotStart, slot.slot_end.toISOString(),
         expiresAtFor('shift'), req.user!.sub, req.user!.role, slot.guards_needed],
      );
      if (!ins.rows[0]) {
        fail('slot_full', 'That slot filled up while this was selected.');
        continue;
      }
      assigned.push({ slot_start: slotStart, shift_id: ins.rows[0].id, action: 'created' });
      created.push(ins.rows[0]);
    }
  }

  res.json({ assigned, failed });

  // ONCE, with ONLY the slots that actually landed — never the requested set.
  // `created` is pushed to exclusively from the two success branches, after
  // their statement returned a row, so a failed slot can never reach it and no
  // guard is told about a shift that does not exist.
  //
  // PATCHed rows are included alongside created ones: a guard newly holding a
  // previously-unassigned shift needs telling just as much, and
  // PATCH /:id/assign-guard already pushes for exactly that transition.
  //
  // Fire-and-forget after the response, matching all four existing call sites.
  // generateTaskInstancesForShift is deliberately NOT called — it has a single
  // call site at routes/shifts.ts:3736 (clock-in), its ON CONFLICT DO NOTHING
  // is inert because task_instances has no unique index beyond its uuid PK, so
  // a second call duplicates rows rather than no-opping.
  if (created.length > 0) {
    pushShiftAssignments(created).catch((err) =>
      console.error('[scheduling.assign-slots] push failed:', err));
  }
});

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
