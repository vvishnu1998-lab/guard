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
// Rolling 14-day window from now. required = SUM(guards_needed) over the
// active profile's shifts × 2 (each day-of-week appears twice in a 14-day
// window). scheduled = count of non-cancelled shifts at the site whose
// scheduled_start is within the window. gaps = max(0, required - scheduled).

async function computeCoverage(siteIds: string[]): Promise<Array<{
  site_id: string;
  has_active_profile: boolean;
  required: number;
  scheduled: number;
  gaps: number;
}>> {
  if (siteIds.length === 0) return [];
  // Aggregate required from the active profiles.
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

  const scheduledRows = await pool.query<{ site_id: string; scheduled: string }>(
    `SELECT s.site_id, COUNT(*) AS scheduled
       FROM shifts s
      WHERE s.site_id = ANY($1::uuid[])
        AND s.status <> 'cancelled'
        AND s.scheduled_start >= NOW()
        AND s.scheduled_start <= NOW() + INTERVAL '14 days'
      GROUP BY s.site_id`,
    [siteIds],
  );
  const scheduledMap = new Map<string, number>();
  for (const r of scheduledRows.rows) scheduledMap.set(r.site_id, Number(r.scheduled));

  return siteIds.map((siteId) => {
    const hasProfile = requiredMap.has(siteId);
    const required   = requiredMap.get(siteId)   ?? 0;
    const scheduled  = scheduledMap.get(siteId)  ?? 0;
    return {
      site_id:            siteId,
      has_active_profile: hasProfile,
      required,
      scheduled,
      gaps:               Math.max(0, required - scheduled),
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
