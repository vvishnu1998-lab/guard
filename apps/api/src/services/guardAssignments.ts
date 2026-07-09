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
 * Audit-row writer for guard_site_assignments mutations. Schema_v20 added
 * the `guard_assignment_audit` table with no FK on `assignment_id`
 * (intentional — the DELETE path writes the audit row in the same txn as
 * the parent DELETE, and a real FK would either cascade-wipe the audit or
 * null-out the back-link the moment the row dies). Pass the same txn
 * `client` so insert + parent mutation share atomicity.
 *
 * The CHECK constraint on `action` only permits the spec-defined trio.
 */
export type AssignmentAuditAction =
  | 'guard_assignment_created'
  | 'guard_assignment_ended'
  | 'guard_assignment_removed';

export async function writeAssignmentAudit(
  client: Querier,
  args: {
    assignmentId: string;
    action: AssignmentAuditAction;
    changedBy: string;
    before: unknown | null;
    after: unknown | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO guard_assignment_audit (assignment_id, action, changed_by, before, after)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      args.assignmentId,
      args.action,
      args.changedBy,
      args.before === null ? null : JSON.stringify(args.before),
      args.after  === null ? null : JSON.stringify(args.after),
    ],
  );
}

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
 * Lists the sites a guard has an open assignment for. The /admin/shifts
 * modal calls this when an admin picks a guard so it can narrow the site
 * dropdown to that guard's permission surface.
 *
 * "Open assignment" = still-valid end (assigned_until IS NULL, or in the
 * future). Note there is NO lower bound on assigned_from — future-dated
 * assignments are included so an admin can schedule a shift at a site
 * whose assignment starts next Monday even though today is Friday.
 * Belt-and-braces: the shift POST + reassign endpoints re-validate that
 * each emitted shift's date falls inside the assignment window
 * (see `checkShiftEligibility` below), so widening the dropdown doesn't
 * let an admin actually create a shift outside the window.
 *
 * Inactive sites are filtered out — an admin shouldn't be invited to
 * schedule a shift at a deactivated site even if the assignment row
 * still exists.
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
      WHERE gsa.guard_id = $1
        AND (gsa.assigned_until IS NULL OR gsa.assigned_until >= $2::date)
        AND s.is_active = true
      ORDER BY s.name`,
    [guardId, dateStr],
  );
  return r.rows;
}

/**
 * Belt-and-braces gate for the shift POST + reassign paths. Returns
 * why a shift on `dateStr` isn't allowed for this guard/site combo so
 * the caller can craft a specific 422 message.
 *
 * Kept separate from isGuardAssignedToSite (which returns just a
 * boolean) because the modal shifted to letting admins pick sites for
 * future-dated assignments — so we now need to distinguish "no
 * assignment at all" from "assignment starts later" for a useful error.
 *
 * `dateStr` and the returned assigned_from/until are YYYY-MM-DD strings
 * so they compare lexicographically — no Date-object timezone hazards.
 */
export type ShiftEligibility =
  | { ok: true }
  | { ok: false; reason: 'not_assigned';  siteName: string }
  | { ok: false; reason: 'before_start';  siteName: string; assignedFrom:  string }
  | { ok: false; reason: 'after_end';     siteName: string; assignedUntil: string };

export async function checkShiftEligibility(
  guardId: string,
  siteId: string,
  dateStr: string,
  db: Querier = pool,
): Promise<ShiftEligibility> {
  const siteRow = await db.query<{ name: string }>(
    'SELECT name FROM sites WHERE id = $1',
    [siteId],
  );
  const siteName = siteRow.rows[0]?.name ?? 'the site';

  // Force string form on both dates so comparisons stay lexicographic
  // regardless of node-pg's DATE parser (which otherwise yields JS Date
  // objects at UTC midnight — a well-known off-by-one hazard for us).
  const rows = await db.query<{ assigned_from: string; assigned_until: string | null }>(
    `SELECT to_char(assigned_from,  'YYYY-MM-DD') AS assigned_from,
            to_char(assigned_until, 'YYYY-MM-DD') AS assigned_until
       FROM guard_site_assignments
      WHERE guard_id = $1 AND site_id = $2
      ORDER BY assigned_from DESC`,
    [guardId, siteId],
  );

  if (rows.rowCount === 0) {
    return { ok: false, reason: 'not_assigned', siteName };
  }

  for (const r of rows.rows) {
    if (r.assigned_from <= dateStr &&
        (r.assigned_until === null || r.assigned_until >= dateStr)) {
      return { ok: true };
    }
  }

  // No covering assignment. Prefer the "starts later" message when an
  // upcoming assignment exists (that's the case this task is fixing),
  // otherwise fall back to the most recent past window's end date.
  const upcoming = rows.rows.find((r) => r.assigned_from > dateStr);
  if (upcoming) {
    return { ok: false, reason: 'before_start', siteName, assignedFrom: upcoming.assigned_from };
  }
  const past = rows.rows[0];
  return {
    ok: false,
    reason: 'after_end',
    siteName,
    assignedUntil: past.assigned_until ?? past.assigned_from,
  };
}

/**
 * Render a ShiftEligibility failure into a user-facing 422 error string.
 * Kept in the service so every caller emits identical text.
 */
export function eligibilityError(e: Exclude<ShiftEligibility, { ok: true }>, dateStr: string): string {
  switch (e.reason) {
    case 'not_assigned':
      return `Guard is not assigned to ${e.siteName}.`;
    case 'before_start':
      return `Cannot schedule shift on ${dateStr} — guard's assignment for ${e.siteName} starts ${e.assignedFrom}.`;
    case 'after_end':
      return `Cannot schedule shift on ${dateStr} — guard's assignment for ${e.siteName} ended ${e.assignedUntil}.`;
  }
}
