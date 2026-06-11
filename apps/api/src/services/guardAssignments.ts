/**
 * Guard ↔ site assignment helpers.
 *
 * Phase A: guard_site_assignments becomes the source of truth for "this
 * guard is allowed to work this site on this date." Until Phase A, the
 * table was display-only (admin list) + a login gate; nothing actually
 * enforced shift creation against it.
 *
 * Convention — date inputs are Pacific YYYY-MM-DD strings, same shape
 * apps/api/src/services/pacificDate.ts works in. We never accept Date
 * objects here so callers can't accidentally pass UTC-midnight values
 * and get off-by-one results across the Pacific date line.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

type Querier = Pick<PoolClient, 'query'>;

/**
 * True iff the guard has an assignment row covering `dateStr` for the
 * given site. An open-ended assignment (assigned_until IS NULL) covers
 * any date on or after assigned_from.
 *
 * Accepts an optional `db` client so callers inside a transaction get
 * read-your-own-writes consistency (relevant for the assigned-sites
 * endpoint backing the modal — not strictly needed for the shift POST
 * enforcement since the assignment write happens on a different request).
 */
export async function isGuardAssignedToSite(
  guardId: string,
  siteId: string,
  dateStr: string,
  db: Querier = pool,
): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM guard_site_assignments
      WHERE guard_id = $1
        AND site_id  = $2
        AND assigned_from <= $3::date
        AND (assigned_until IS NULL OR assigned_until >= $3::date)
      LIMIT 1`,
    [guardId, siteId, dateStr],
  );
  return r.rowCount! > 0;
}

/**
 * Lists the sites a guard is currently assigned to as of `dateStr`.
 * The /admin/shifts modal calls this when an admin picks a guard so it
 * can narrow the site dropdown to that guard's permission surface.
 *
 * The query joins to `sites` so we can return human-readable names in a
 * single round-trip. Inactive sites are filtered out — an admin
 * shouldn't be invited to schedule a shift at a deactivated site even
 * if the assignment row still exists.
 */
export async function getAssignedSitesForGuard(
  guardId: string,
  dateStr: string,
  db: Querier = pool,
): Promise<{ site_id: string; site_name: string }[]> {
  const r = await db.query(
    `SELECT s.id AS site_id, s.name AS site_name
       FROM guard_site_assignments gsa
       JOIN sites s ON s.id = gsa.site_id
      WHERE gsa.guard_id    = $1
        AND gsa.assigned_from <= $2::date
        AND (gsa.assigned_until IS NULL OR gsa.assigned_until >= $2::date)
        AND s.is_active = true
      ORDER BY s.name`,
    [guardId, dateStr],
  );
  return r.rows;
}
