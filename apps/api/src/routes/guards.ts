import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';
import { validatePassword, logEvent } from './auth';
import { generateTempPassword } from '../utils/tempPassword';
import { getAssignedSitesForGuard, writeAssignmentAudit, assignmentCoversDateSql } from '../services/guardAssignments';
import { overlapPredicateSql } from '../services/shiftOverlap';
import { pacificTodayStr, isPastPacificDateString } from '../services/pacificDate';
import { Sentry } from '../services/sentry';
import { sendGuardWelcomeEmail } from '../services/email';
import { findOpenSession, clockedInAtPacific, OpenSessionConflictBody } from '../services/openSession';

const router = Router();

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
// Same constant, same regex, as routes/scheduling.ts:32, routes/reports.ts:43
// and routes/inspections.ts:46. Guards a bare `WHERE id = $1` against a
// non-uuid path param, which Postgres answers with 22P02 and Express turns
// into a 500 rather than the 400 it is.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/guards/me — guard's own profile (used by mobile profile tab)
router.get('/me', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g.email, g.badge_number, g.created_at,
            co.name as company_name
     FROM guards g
     JOIN companies co ON co.id = g.company_id
     WHERE g.id = $1`,
    [req.user!.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Guard not found' });
  res.json(result.rows[0]);
});

router.get('/', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  // company_name is included on every row so the admin UI can disambiguate
  // when the result set spans multiple companies (Vishnu view). The frontend
  // only surfaces the label when Set<company_name>.size > 1, so single-tenant
  // (company_admin) views stay visually unchanged.
  const result = await pool.query(
    `SELECT g.id, g.name, g.email, g.badge_number, g.is_active, g.must_change_password, g.created_at,
            co.name AS company_name,
            array_agg(json_build_object(
              'id', gsa.id,
              'site_id', gsa.site_id, 'site_name', s.name,
              'site_is_active', s.is_active,
              'assigned_from', gsa.assigned_from, 'assigned_until', gsa.assigned_until))
              FILTER (WHERE gsa.id IS NOT NULL) as assignments
     FROM guards g
     JOIN companies co ON co.id = g.company_id
     LEFT JOIN guard_site_assignments gsa ON gsa.guard_id = g.id
     LEFT JOIN sites s ON s.id = gsa.site_id
     ${isVishnu ? '' : 'WHERE g.company_id = $1'}
     GROUP BY g.id, co.name ORDER BY g.name`,
    isVishnu ? [] : [req.user!.company_id]
  );
  res.json(result.rows);
});

// POST /api/guards — create a guard with a server-generated badge number.
//
// Badge format: GRD#### (zero-padded 4-digit int), scoped per company. The
// next number is MAX(existing GRD#### badges for this company) + 1. Any
// non-GRD#### legacy badges (grd01, 002, etc.) are ignored for the max
// calculation and grandfathered as-is. If a caller supplies badge_number
// in the body, it's ignored — the server is authoritative.
//
// Concurrency: badge generation and INSERT run inside one transaction with
// a per-company xact-scoped advisory lock. Two concurrent POSTs for the
// same company queue rather than racing on MAX(...) + INSERT. bcrypt runs
// BEFORE the transaction (it's ~200ms) so the lock is held only for the
// couple of fast queries.
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { name, email, badge_number: bodyBadge, temp_password } = req.body;

  // Validate required fields (badge_number is auto-generated — no longer required)
  if (!name?.trim())    return res.status(400).json({ error: 'Guard name is required' });
  if (!email?.trim())   return res.status(400).json({ error: 'Email is required' });
  if (!temp_password)   return res.status(400).json({ error: 'Temporary password is required' });
  // Forced rotation on first login is wired via guards.must_change_password DEFAULT true.
  const policyErr = validatePassword(temp_password);
  if (policyErr) return res.status(400).json({ error: policyErr });

  if (bodyBadge != null && String(bodyBadge).trim() !== '') {
    // Auto-generation is authoritative — any client-supplied badge is
    // ignored. Logged so a stale-client deploy shows up in logs.
    console.warn('[POST /api/guards] badge_number in body ignored (auto-generated)');
  }

  const password_hash = await bcrypt.hash(temp_password, 12);   // slow: outside txn

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialize badge generation per company. hashtext(uuid_text) → int4;
    // pg_advisory_xact_lock's 2-arg form takes (int, int) — namespace 0 is
    // arbitrary but stable. Lock releases on COMMIT or ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(0, hashtext($1))', [req.user!.company_id]);

    const maxRes = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(badge_number FROM 4) AS INTEGER)), 0) AS max_num
       FROM guards
       WHERE company_id = $1 AND badge_number ~ '^GRD[0-9]{4}$'`,
      [req.user!.company_id]
    );
    const nextNum = Number(maxRes.rows[0].max_num) + 1;
    if (nextNum > 9999) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Badge rollover: this company has reached GRD9999. Contact support.' });
    }
    const badge = `GRD${String(nextNum).padStart(4, '0')}`;

    const result = await client.query(
      `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, badge_number, is_active, created_at`,
      [req.user!.company_id, name.trim(), email.trim().toLowerCase(), password_hash, badge]
    );
    await client.query('COMMIT');
    const newGuard = result.rows[0];
    res.status(201).json(newGuard);

    sendGuardWelcomeEmail({
      guard_id:      newGuard.id,
      guard_name:    newGuard.name,
      guard_email:   newGuard.email,
      // requireAuth('company_admin') guarantees company_id is set. Second !
      // narrows the optional field type on AuthPayload.
      company_id:    req.user!.company_id!,
      temp_password: temp_password,
    }).catch((err) => Sentry.captureException(err));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    // PostgreSQL unique_violation = error code 23505
    if (err.code === '23505' && err.constraint?.includes('email')) {
      return res.status(409).json({ error: 'A guard with this email already exists' });
    }
    if (err.code === '23505' && err.constraint?.includes('badge')) {
      // Should be unreachable while the advisory lock is in place, but keep
      // the 409 as a defence-in-depth so any manual INSERT bypassing the
      // lock still surfaces a clean error to the caller.
      return res.status(409).json({ error: 'A guard with this badge number already exists' });
    }
    console.error('[POST /api/guards] Error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to create guard' });
  } finally {
    client.release();
  }
});

// POST /api/guards/:id/resend-welcome — rotate temp password, kick session, resend welcome email.
/**
 * POST /api/guards/shift-candidates — who can take THIS SET of shifts.
 *
 * Body: { shift_ids: uuid[] }   (1..200)
 *
 * POST FOR A READ, DELIBERATELY, for the same reason
 * routes/scheduling.ts:536-541 gives: the input is a SET, and 200 uuids in a
 * query string works until it doesn't. It writes nothing.
 *
 * EVERY GUARD IN THE COMPANY IS RETURNED, none filtered. An unavailable guard
 * comes back greyed WITH THE REASON. Filtering them out is what makes an
 * admin ask "where is X?" and get no answer — and offering them and then
 * rejecting the write is worse still, which is exactly what the bulk-reassign
 * dropdown did before this endpoint existed: pick a guard, watch nine of ten
 * shifts fail, learn why afterwards.
 *
 * This is slot-candidates' shape keyed on shift_id instead of slot_start.
 * Same envelope — guard_id, name, badge_number, is_active, total, free_count,
 * blocked[{..., reason, conflict}] — because the web renders both through the
 * same mental model and a second envelope would fork it. It is NOT the same
 * query: a slot is derived arithmetic with a capacity, a shift is a row.
 *
 * ── THE POOL ────────────────────────────────────────────────────────────
 *
 * Shifts are RE-DERIVED from the database, never taken from the client, using
 * the SAME read set both surfaces already use: `status <> 'cancelled' AND
 * scheduled_end > NOW()`. An id that no longer qualifies is silently dropped
 * and named in `shift_ids`, so a stale selection cannot widen what is
 * evaluated, and the endpoint cannot disagree with the dialog about what is
 * upcoming.
 *
 * `scheduled_end`, not `scheduled_start` — the whole reason this arc exists.
 * A shift that has already started with nobody on it is precisely the row an
 * admin needs to move.
 *
 * ── TWO INTERVAL SEMANTICS, BOTH DELIBERATE, NEITHER RECONCILED ─────────
 *
 * The same pair routes/scheduling.ts:547-566 states for slots, and this
 * endpoint must agree with the write path or the dropdown promises something
 * PATCH /api/shifts/:id/reassign refuses.
 *
 *   ASSIGNMENT WINDOW — CLOSED, on CALENDAR DATES, site-local.
 *     assigned_from <= d AND (assigned_until IS NULL OR assigned_until >= d)
 *     An assignment ending 2026-09-20 DOES cover a shift on 2026-09-20. `d`
 *     is the shift's SITE-LOCAL day, not a UTC day. Spelled once, in
 *     services/guardAssignments.ts:assignmentCoversDateSql, and composed here
 *     rather than rewritten.
 *
 *   OVERLAP — HALF-OPEN [start, end), on INSTANTS, CROSS-SITE.
 *     Strict `<` and `>`: a shift ending 16:00 and one starting 16:00 do not
 *     collide, and there is deliberately no rest-gap rule. No site_id term —
 *     a guard cannot be in two places at once whoever's post it is. Spelled
 *     once, in services/shiftOverlap.ts:overlapPredicateSql, which
 *     findOverlappingShift itself is also built from, so the scalar write-path
 *     check and this batch read cannot drift.
 *
 * ── Why fragments and not the scalar helpers in a loop ──────────────────
 *
 * checkShiftEligibility and findOverlappingShift answer one cell each. This
 * endpoint has guards x shifts cells: 16 x 25 = 400 for STARNET's worst real
 * case, 5,600 at the 200-shift cap, and eligibility costs two queries per
 * call. Composing the shared fragments keeps ONE spelling of each predicate
 * while asking the question once.
 *
 * ── One case this does NOT catch, stated plainly ────────────────────────
 *
 * Overlap excludes only the shift being evaluated (`sh2.id <> s.id`), exactly
 * as findOverlappingShift's excludeShiftId does. If an admin selects two
 * shifts that overlap EACH OTHER and assigns both to one guard, both look
 * free here and the second is refused at write time with a 409. Selecting a
 * self-overlapping set is not a thing the UI encourages and the write path
 * still catches it, so this is a known gap rather than a hidden one.
 */
router.post('/shift-candidates', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const raw = (req.body as { shift_ids?: unknown })?.shift_ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(422).json({ error: 'shift_ids must be a non-empty array' });
  }
  if (raw.length > 200) {
    return res.status(422).json({ error: 'Too many shifts — max 200' });
  }
  if (!raw.every((v) => typeof v === 'string' && UUID_RE.test(v))) {
    return res.status(422).json({ error: 'shift_ids must be uuids' });
  }
  const shiftIds = raw as string[];

  // Guards are scoped to the SHIFTS' company, not the caller's — vishnu has
  // no company_id of its own, and a guard from another tenant can never work
  // these posts. A selection spanning two tenants is a bug in the caller, not
  // a query to answer.
  const scope = await pool.query<{ company_id: string }>(
    `SELECT DISTINCT si.company_id
       FROM shifts sh JOIN sites si ON si.id = sh.site_id
      WHERE sh.id = ANY($1::uuid[])`,
    [shiftIds],
  );
  if (scope.rows.length === 0) return res.status(404).json({ error: 'No matching shifts' });
  if (scope.rows.length > 1) {
    return res.status(422).json({ error: 'shift_ids span multiple companies' });
  }
  const companyId = scope.rows[0].company_id;
  if (req.user!.role !== 'vishnu' && companyId !== req.user!.company_id) {
    return res.status(404).json({ error: 'No matching shifts' });
  }

  const overlapSql = overlapPredicateSql({
    guardCol:  'sh2.guard_id',
    statusCol: 'sh2.status',
    startCol:  'sh2.scheduled_start',
    endCol:    'sh2.scheduled_end',
    guardExpr: 'c.id',
    winStart:  's.scheduled_start',
    winEnd:    's.scheduled_end',
  });
  const windowSql = assignmentCoversDateSql({
    gsaAlias: 'gsa',
    dateExpr: '(s.scheduled_start AT TIME ZONE s.site_tz)::date',
  });

  const { rows } = await pool.query<{
    guard_id: string; name: string; badge_number: string; is_active: boolean;
    total: number; free_count: number; blocked: unknown;
  }>(
    `WITH sel AS (
       SELECT sh.id, sh.site_id, sh.guard_id, sh.status,
              sh.scheduled_start, sh.scheduled_end,
              si.timezone AS site_tz
         FROM shifts sh
         JOIN sites si ON si.id = sh.site_id
        WHERE sh.id = ANY($1::uuid[])
          AND sh.status <> 'cancelled'
          AND sh.scheduled_end > NOW()
     ),
     cand AS (
       SELECT g.id, g.name, g.badge_number, g.is_active
         FROM guards g
        WHERE g.company_id = $2
     ),
     cell AS (
       SELECT c.id AS guard_id, c.name, c.badge_number, c.is_active,
              s.id AS shift_id, s.scheduled_start AS sel_start,
              CASE
                WHEN NOT c.is_active THEN 'guard_inactive'
                -- Listed by the dialog, not movable by the write path. Named
                -- rather than dropped, so the count the admin sees and the
                -- count this endpoint scores are the same number.
                --
                -- 'unassigned' IS ADMITTED. The bulk surface has ONE verb,
                -- ASSIGN, covering both cases: a shift with a guard gets
                -- moved (PATCH /shifts/:id/reassign), one without gets
                -- filled (PATCH /shifts/:id/assign-guard). The admin is
                -- picking a guard either way, so this endpoint has to score
                -- both or the dropdown would report every guard blocked for
                -- exactly the rows the admin most needs to fill.
                --
                -- The label stays accurate: after this widening the statuses
                -- this branch still catches are completed, missed and
                -- cancelled, which is what 'not_reassignable' has always
                -- meant to a reader.
                WHEN s.status NOT IN ('scheduled','active','unassigned') THEN 'not_reassignable'
                -- NULL-SAFE ON PURPOSE, no change needed for unassigned rows.
                -- s.guard_id = c.id evaluates to NULL when the shift has no
                -- guard, which is falsy, so this never fires on the rows
                -- admitted above. The overlap LATERAL below is likewise
                -- indifferent: it matches sh2.guard_id against the CANDIDATE
                -- (c.id), and the row under evaluation contributes only its
                -- time window.
                WHEN s.guard_id = c.id THEN 'already_on_shift'
                WHEN NOT EXISTS (
                  SELECT 1 FROM guard_site_assignments gsa
                   WHERE gsa.guard_id = c.id
                     AND gsa.site_id  = s.site_id
                     AND ${windowSql}
                ) THEN 'not_assigned_to_site'
                WHEN cf.shift_id IS NOT NULL THEN 'overlap'
                ELSE NULL
              END AS reason,
              cf.shift_id AS conflict_id, cf.site_name AS conflict_site,
              cf.scheduled_start AS conflict_start, cf.scheduled_end AS conflict_end
         FROM cand c
         CROSS JOIN sel s
         LEFT JOIN LATERAL (
           SELECT sh2.id AS shift_id, si2.name AS site_name,
                  sh2.scheduled_start, sh2.scheduled_end
             FROM shifts sh2
             JOIN sites si2 ON si2.id = sh2.site_id
            WHERE sh2.id <> s.id
              AND ${overlapSql}
            ORDER BY sh2.scheduled_start
            LIMIT 1
         ) cf ON true
     )
     SELECT guard_id, name, badge_number, is_active,
            COUNT(*)::int                              AS total,
            COUNT(*) FILTER (WHERE reason IS NULL)::int AS free_count,
            COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
              'shift_id', shift_id,
              'reason',   reason,
              'conflict', CASE WHEN conflict_id IS NULL THEN NULL ELSE JSON_BUILD_OBJECT(
                            'shift_id',        conflict_id,
                            'site_name',       conflict_site,
                            'scheduled_start', conflict_start,
                            'scheduled_end',   conflict_end) END
            ) ORDER BY sel_start) FILTER (WHERE reason IS NOT NULL), '[]') AS blocked
       FROM cell
      GROUP BY guard_id, name, badge_number, is_active
      ORDER BY free_count DESC, name ASC`,
    [shiftIds, companyId],
  );

  // What was actually scored, so the client can tell a dropped id from a
  // blocked one rather than inferring it from a count mismatch.
  const matched = await pool.query<{ id: string }>(
    `SELECT sh.id FROM shifts sh
      WHERE sh.id = ANY($1::uuid[])
        AND sh.status <> 'cancelled'
        AND sh.scheduled_end > NOW()`,
    [shiftIds],
  );

  res.json({
    shift_ids:   matched.rows.map((r) => r.id),
    shift_count: matched.rows.length,
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

router.post('/:id/resend-welcome', requireAuth('company_admin'), async (req, res) => {
  const guardResult = await pool.query<{
    id: string; name: string; email: string; company_id: string;
  }>(
    `SELECT id, name, email, company_id
       FROM guards
      WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [req.params.id, req.user!.company_id],
  );
  const guard = guardResult.rows[0];
  if (!guard) return res.status(404).json({ error: 'Guard not found' });

  const tempPassword = generateTempPassword(12);
  const password_hash = await bcrypt.hash(tempPassword, 12);

  await pool.query(
    `UPDATE guards
        SET password_hash        = $1,
            must_change_password = true,
            tokens_not_before    = NOW()
      WHERE id = $2`,
    [password_hash, guard.id],
  );

  let email_status: 'sent' | 'failed' = 'sent';
  try {
    await sendGuardWelcomeEmail({
      guard_id:      guard.id,
      guard_name:    guard.name,
      guard_email:   guard.email,
      company_id:    guard.company_id,
      temp_password: tempPassword,
    });
    await logEvent(guard.id, 'guard', 'welcome_email_resent', req);
  } catch (err) {
    email_status = 'failed';
    Sentry.captureException(err);
    await logEvent(guard.id, 'guard', 'welcome_email_send_failed', req);
  }

  res.json({ temp_password: tempPassword, email_status });
});

/**
 * GET /api/guards/:guardId/deactivation-impact
 *
 * Everything an admin needs to decide whether to deactivate this guard, and
 * — if they proceed — to choose between REASSIGNING the shifts and letting
 * the override UNASSIGN them. Read-only. Writes nothing, blocks nothing; the
 * gates live on PATCH /:id/deactivate. This is what the dialog reads BEFORE
 * the admin has picked anything.
 *
 * Distinct from GET /:guardId/assignments/:id/impact, which answers a
 * narrower and unrelated question (one assignment, one site, no block).
 *
 * ── The predicate: scheduled_end > NOW(), NOT scheduled_start > NOW() ────
 *
 * This is the whole reason the endpoint exists rather than reusing the
 * per-assignment one. Measured against prod at 408a5cf: FOUR shifts are in
 * status 'scheduled' with scheduled_start <= NOW() < scheduled_end — started,
 * nobody clocked in. `scheduled_start > NOW()` does not see them, and the
 * clocked-in block below does not catch them either, because there is no open
 * session to find. A shift happening RIGHT NOW with an empty post was the one
 * thing falling through both gates.
 *
 * On the guard the brief named — c4c9b7f7-a578-42bc-856e-9876d7e1765e — the
 * two predicates return 24 and 25. The extra row is exactly that case.
 *
 * ── `status <> 'cancelled'`, and where it will drift ────────────────────
 *
 * Ruled as "non-cancelled" rather than the IN ('scheduled','active') that
 * services/shiftOverlap.ts and all four latch crons use. On today's data the
 * two are the SAME SET: of 151 non-cancelled rows with scheduled_end > NOW(),
 * 148 are 'scheduled' and 3 are 'active'. Zero are 'completed', 'missed' or
 * 'unassigned'.
 *
 * They diverge the first time a guard clocks out early: that leaves a
 * 'completed' row whose scheduled_end is still in the future, and this
 * endpoint would then offer finished work for reassignment. `status` is
 * returned on every shift so the dialog can see that if it happens, and so
 * the divergence is visible rather than silent. Filed rather than pre-empted.
 *
 * ── Grouped by site, because one number is not a decision ───────────────
 *
 * The per-assignment route returns future_shift_count plus five sample dates.
 * That is not enough here: the worst case in prod is 25 shifts, two guards
 * hold future work at more than one site, and reassignment is necessarily a
 * PER-SITE choice — a replacement guard must be assigned to the site the
 * shift is at. So the payload groups by site, with exact counts and the real
 * date span per site, and the shift rows underneath.
 *
 * ── The open-session check rides along ──────────────────────────────────
 *
 * Same response, so the dialog knows deactivation is blocked before the admin
 * picks anything, instead of composing a reassignment and being refused on
 * submit. `open_session_conflict` is OpenSessionConflictBody — the shape
 * routes/shifts.ts has returned from its two clock-in call sites since it was
 * written, key for key, type for type.
 *
 * ONE THING IS NOT VERBATIM, AND DELIBERATELY: the prose. That function's
 * message is second-person guard copy ("You're already clocked in at X") and
 * is correct on a guard's own clock-in. Returned unchanged to an ADMIN asking
 * about a DIFFERENT person it would read as an accusation about the admin.
 * The message here is third-person and names the guard. The shape is reused;
 * the voice is not, because the audience changed.
 *
 * Note the failure direction: findOpenSession swallows a lookup error and
 * returns null, so a database blip renders as "not blocked". That is fine
 * HERE — this endpoint only informs — and it is why the block itself is
 * re-checked inside the write path in PATCH /:id/deactivate rather than
 * trusted from this response.
 *
 * ── Identity ────────────────────────────────────────────────────────────
 *
 * Keyed on uuid throughout. badge_number is returned for DISPLAY beside the
 * name and must never be used to look a guard up: six badges collide across
 * tenants, including two GRD0011s — one inactive at STARNET holding the
 * orphaned shift, one active at Star Guard with seven future shifts.
 */

/** Hard cap on the shift rows returned. Counts and date spans are computed
 *  from the FULL set by a separate aggregate, so a truncated list never
 *  produces a wrong number — only a short list, flagged per site. 200 is far
 *  above the observed worst case of 25. */
const DEACTIVATION_IMPACT_SHIFT_CAP = 200;

router.get('/:guardId/deactivation-impact', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const guardId = req.params.guardId;
  if (!UUID_RE.test(guardId)) return res.status(400).json({ error: 'invalid guardId' });

  // Tenant scope for company_admin. Returns null for vishnu, who has none —
  // hence the existence check below, which 404s for BOTH roles.
  const tenantErr = await guardBelongsToCaller(req);
  if (tenantErr) return res.status(tenantErr.status).json(tenantErr.body);

  const guardRes = await pool.query<{
    id: string; name: string; badge_number: string; is_active: boolean;
  }>(
    'SELECT id, name, badge_number, is_active FROM guards WHERE id = $1',
    [guardId],
  );
  const guard = guardRes.rows[0];
  if (!guard) return res.status(404).json({ error: 'Guard not found' });

  // Counts and spans come from the aggregate, never from the row list.
  const bySite = await pool.query<{
    site_id: string; site_name: string; site_is_active: boolean;
    site_timezone: string; shift_count: number;
    first_start: Date; last_start: Date;
  }>(
    `SELECT s.site_id,
            si.name       AS site_name,
            si.is_active  AS site_is_active,
            si.timezone   AS site_timezone,
            COUNT(*)::int AS shift_count,
            MIN(s.scheduled_start) AS first_start,
            MAX(s.scheduled_start) AS last_start
       FROM shifts s
       JOIN sites si ON si.id = s.site_id
      WHERE s.guard_id = $1
        AND s.scheduled_end > NOW()
        AND s.status <> 'cancelled'
      GROUP BY s.site_id, si.name, si.is_active, si.timezone
      ORDER BY MIN(s.scheduled_start) ASC`,
    [guardId],
  );

  const rows = await pool.query<{
    id: string; site_id: string;
    scheduled_start: Date; scheduled_end: Date; status: string;
  }>(
    `SELECT s.id, s.site_id, s.scheduled_start, s.scheduled_end, s.status
       FROM shifts s
      WHERE s.guard_id = $1
        AND s.scheduled_end > NOW()
        AND s.status <> 'cancelled'
      ORDER BY s.scheduled_start ASC
      LIMIT $2`,
    [guardId, DEACTIVATION_IMPACT_SHIFT_CAP],
  );

  const shiftsBySite = new Map<string, Array<{
    id: string; scheduled_start: string; scheduled_end: string; status: string;
  }>>();
  for (const r of rows.rows) {
    const list = shiftsBySite.get(r.site_id) ?? [];
    list.push({
      id: r.id,
      scheduled_start: r.scheduled_start.toISOString(),
      scheduled_end:   r.scheduled_end.toISOString(),
      status:          r.status,
    });
    shiftsBySite.set(r.site_id, list);
  }

  const sites = bySite.rows.map((g) => {
    const listed = shiftsBySite.get(g.site_id) ?? [];
    return {
      site_id:        g.site_id,
      site_name:      g.site_name,
      site_is_active: g.site_is_active,
      site_timezone:  g.site_timezone,
      shift_count:    g.shift_count,
      first_start:    g.first_start.toISOString(),
      last_start:     g.last_start.toISOString(),
      shifts:         listed,
      // True only when the global cap trimmed this site's rows. shift_count
      // stays authoritative either way.
      shifts_truncated: listed.length < g.shift_count,
    };
  });

  // Blocked check. Third-person voice; see the docblock.
  const open = await findOpenSession(guardId);
  let openSessionConflict: OpenSessionConflictBody | null = null;
  if (open) {
    const message =
      `${guard.name} is clocked in at ${open.site_name} since ${clockedInAtPacific(open.clocked_in_at)} PT.`;
    openSessionConflict = {
      code: 'OPEN_SESSION_EXISTS',
      error: message,
      message,
      open_session: {
        shift_id:      open.shift_id,
        site_id:       open.site_id,
        site_name:     open.site_name,
        clocked_in_at: open.clocked_in_at.toISOString(),
      },
    };
  }

  res.json({
    guard: {
      id:           guard.id,
      name:         guard.name,
      badge_number: guard.badge_number, // display only — never an identifier
      is_active:    guard.is_active,
    },
    blocked: openSessionConflict !== null,
    open_session_conflict: openSessionConflict,
    future_shift_count: bySite.rows.reduce((n, g) => n + g.shift_count, 0),
    site_count: bySite.rows.length,
    sites,
  });
});


/**
 * PATCH /api/guards/:id/deactivate
 *
 * Was seven lines and one unguarded UPDATE. It could not tell a real guard
 * from a typo, ran outside a transaction, and left every future shift the
 * guard held pointing at somebody who could no longer log in. That is how a
 * guard at 375 Shopping Complex was disabled holding 17 future shifts; 16
 * were cancelled by hand and one was missed, and that orphan is still in the
 * table (7b79fc50-b91a-465c-9b7c-cabf10ab1f9a -> shift
 * b2afb11f-4861-436e-a8c9-5f6ec2961082, 2026-10-05).
 *
 * ── Outcomes ────────────────────────────────────────────────────────────
 *
 *   400  invalid uuid              — previously a 22P02 surfacing as a 500
 *   404  guard not found           — previously `{success:true}` for any uuid
 *   409  OPEN_SESSION_EXISTS       — clocked in. Nothing written.
 *   409  FUTURE_SHIFTS_EXIST       — holds future shifts and the caller did
 *                                    not say what to do with them. Nothing
 *                                    written. THIS is the old bug's fix: a
 *                                    blind deactivate can no longer orphan.
 *   200                            — deactivated, with what was unassigned.
 *
 * ── The WRITE set is narrower than the READ set, deliberately ───────────
 *
 * GET /:guardId/deactivation-impact lists `status <> 'cancelled'`. This route
 * only ever touches `status IN ('scheduled','active')`.
 *
 * They are the same set today (measured 2026-09-10: 148 'scheduled' + 3
 * 'active', zero 'completed'/'missed'/'unassigned' with scheduled_end >
 * NOW()). They diverge the first time a guard clocks out early, which leaves
 * a 'completed' row whose scheduled_end is still ahead. The dialog will list
 * that row; this route will not touch it. That is not an oversight in either
 * direction — the admin should see the whole picture, and a shift the guard
 * has already worked is history. History is not reassignable, and writing
 * status='unassigned' over it would be data loss.
 *
 * The dialog is therefore expected to render a listed-but-untouchable shift
 * as not actionable rather than omitting it.
 *
 * ── Why the whole thing is ONE transaction, and NOT partial-success ──────
 *
 * Phase D's bulk slot assign is per-slot atomic on purpose: N independent
 * slots, each of which can fail for its own reason (guard busy, slot filled
 * up, template changed), and a partial answer is genuinely useful — the seven
 * that worked are done, the three that did not stay ticked for another guard.
 *
 * None of that transfers here. This is ONE guard, and the intermediate states
 * are not partial successes, they are the failure being fixed:
 *
 *   guard inactive + all shifts unassigned   coherent
 *   guard inactive + SOME shifts unassigned  exactly the orphan above
 *   guard active   + shifts unassigned       worse than doing nothing: work
 *                                            stripped from someone who can
 *                                            still log in and show up
 *
 * There is also no per-row failure mode to partially succeed at. Phase D ran
 * a capacity check per slot inside each write; here the unassign is a single
 * `UPDATE ... WHERE id = ANY($1)` over rows already locked, and the only ways
 * it fails are infrastructural — which are all-or-nothing regardless. So:
 * all-or-nothing, one transaction, and no `failed[]` in the response.
 *
 * ── The clock-in interlock ──────────────────────────────────────────────
 *
 * The open-session check runs TWICE and the second one is the real gate.
 *
 * routes/shifts.ts:3702 clock-in does `UPDATE shifts SET status='active'`
 * inside its own transaction. Without an interlock a guard could clock in
 * between a pre-flight check and this commit, and we would unassign the shift
 * they are standing on. So the candidate shifts are SELECT ... FOR UPDATE'd
 * first, and only then is the session re-read THROUGH THE SAME CLIENT: any
 * concurrent clock-in is now either already visible or blocked on our row
 * lock until we commit or roll back.
 *
 * The pre-flight check through the pool is kept anyway — it answers the
 * common blocked case without opening a transaction at all.
 *
 * ── Audit ───────────────────────────────────────────────────────────────
 *
 * One shift_reassignments row per unassigned shift, with new_guard_id NULL —
 * representable only since schema_v74, and constrained by
 * chk_shift_reassignments_direction so a nobody-to-nobody row cannot be
 * written. reason='guard_deactivated' is the first non-NULL reason in that
 * table (all 23 pre-existing rows have NULL), which makes these rows
 * self-describing and trivially separable from every reassignment before them.
 *
 * reassigned_by_role comes from req.user.role rather than a hardcoded
 * 'company_admin', so the row stays correct if this route's auth ever widens.
 *
 * ── Deploy gap ──────────────────────────────────────────────────────────
 *
 * Vercel and Railway never deploy together. API-FIRST is the safe order: an
 * old web client sends no body, so a guard with future shifts gets a 409 and
 * the old UI shows its message via setError — it fails closed and explains
 * itself. Web-first reproduces today's bug exactly once per deactivation,
 * because an old API ignores the flag entirely. That reverse gap cannot be
 * closed from either side; it can only be sequenced.
 */
router.patch('/:id/deactivate', requireAuth('company_admin'), async (req, res) => {
  const guardId = req.params.id;
  if (!UUID_RE.test(guardId)) return res.status(400).json({ error: 'invalid guard id' });

  const body = (req.body ?? {}) as { unassign_future_shifts?: unknown };
  if (body.unassign_future_shifts !== undefined && typeof body.unassign_future_shifts !== 'boolean') {
    return res.status(400).json({ error: 'unassign_future_shifts must be a boolean' });
  }
  const confirmedUnassign = body.unassign_future_shifts === true;

  // Pre-flight, through the pool: answers the blocked case without opening a
  // transaction. NOT the authoritative check — see the interlock note above.
  const preOpen = await findOpenSession(guardId);
  if (preOpen) {
    const message =
      `Cannot deactivate: this guard is clocked in at ${preOpen.site_name} since ${clockedInAtPacific(preOpen.clocked_in_at)} PT.`;
    const conflict: OpenSessionConflictBody = {
      code: 'OPEN_SESSION_EXISTS',
      error: message,
      message,
      open_session: {
        shift_id:      preOpen.shift_id,
        site_id:       preOpen.site_id,
        site_name:     preOpen.site_name,
        clocked_in_at: preOpen.clocked_in_at.toISOString(),
      },
    };
    return res.status(409).json(conflict);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Existence + tenant + lock in one statement. The old route had none of
    // the three: any uuid at all returned {success:true}.
    const guardRes = await client.query<{ id: string; name: string; is_active: boolean }>(
      `SELECT id, name, is_active FROM guards
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [guardId, req.user!.company_id],
    );
    const guard = guardRes.rows[0];
    if (!guard) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Guard not found' });
    }

    // The WRITE set. Narrower than the impact endpoint's READ set by design.
    // FOR UPDATE is the clock-in interlock, not just an isolation nicety.
    const shiftRes = await client.query<{ id: string; site_id: string }>(
      `SELECT s.id, s.site_id
         FROM shifts s
        WHERE s.guard_id = $1
          AND s.scheduled_end > NOW()
          AND s.status IN ('scheduled', 'active')
        ORDER BY s.scheduled_start ASC
        FOR UPDATE`,
      [guardId],
    );
    const shiftIds = shiftRes.rows.map((r) => r.id);

    // Authoritative re-check, through the SAME client, AFTER the locks.
    const openNow = await findOpenSession(guardId, client);
    if (openNow) {
      await client.query('ROLLBACK');
      const message =
        `Cannot deactivate: this guard is clocked in at ${openNow.site_name} since ${clockedInAtPacific(openNow.clocked_in_at)} PT.`;
      const conflict: OpenSessionConflictBody = {
        code: 'OPEN_SESSION_EXISTS',
        error: message,
        message,
        open_session: {
          shift_id:      openNow.shift_id,
          site_id:       openNow.site_id,
          site_name:     openNow.site_name,
          clocked_in_at: openNow.clocked_in_at.toISOString(),
        },
      };
      return res.status(409).json(conflict);
    }

    if (shiftIds.length > 0 && !confirmedUnassign) {
      await client.query('ROLLBACK');
      // Enough for a non-UI caller to understand the refusal without a second
      // request; the full per-shift breakdown lives on
      // GET /:guardId/deactivation-impact, which is what the dialog reads.
      const bySite = new Map<string, number>();
      for (const r of shiftRes.rows) bySite.set(r.site_id, (bySite.get(r.site_id) ?? 0) + 1);
      const message =
        `${guard.name} holds ${shiftIds.length} future shift${shiftIds.length === 1 ? '' : 's'} across ${bySite.size} site${bySite.size === 1 ? '' : 's'}. Reassign them, or confirm to unassign.`;
      return res.status(409).json({
        code: 'FUTURE_SHIFTS_EXIST',
        error: message,
        message,
        future_shift_count: shiftIds.length,
        site_count: bySite.size,
        // Echo the flag the caller must send to proceed, so the contract is
        // discoverable from the refusal itself.
        confirm_with: { unassign_future_shifts: true },
      });
    }

    if (shiftIds.length > 0) {
      // Both columns explicitly. Nothing in the schema ties status
      // ='unassigned' to guard_id IS NULL — the pairing holds in prod only
      // because every writer happens to set both, and this writer will not be
      // the one that breaks it.
      await client.query(
        `UPDATE shifts
            SET status = 'unassigned', guard_id = NULL
          WHERE id = ANY($1::uuid[])`,
        [shiftIds],
      );

      // One audit row per shift, in one statement. new_guard_id NULL is the
      // schema_v74 widening; old_guard_id is always set here, which is what
      // keeps chk_shift_reassignments_direction satisfied.
      await client.query(
        `INSERT INTO shift_reassignments
           (shift_id, old_guard_id, new_guard_id, reassigned_by_admin_id, reassigned_by_role, reason)
         SELECT unnest($1::uuid[]), $2, NULL, $3, $4, 'guard_deactivated'`,
        [shiftIds, guardId, req.user!.sub, req.user!.role],
      );
    }

    const deact = await client.query<{ id: string; name: string; is_active: boolean }>(
      `UPDATE guards SET is_active = false
        WHERE id = $1 AND company_id = $2
        RETURNING id, name, is_active`,
      [guardId, req.user!.company_id],
    );
    if (!deact.rows[0]) {
      // Unreachable given the locked SELECT above, which is why it rolls back
      // rather than trying to interpret it.
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Guard not found' });
    }

    await client.query('COMMIT');
    return res.json({
      success: true,
      guard: deact.rows[0],
      unassigned_count: shiftIds.length,
      unassigned_shift_ids: shiftIds,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection already gone */ });
    throw err;
  } finally {
    client.release();
  }
});

router.patch('/:id/reactivate', requireAuth('company_admin'), async (req, res) => {
  const result = await pool.query(
    'UPDATE guards SET is_active = true WHERE id = $1 AND company_id = $2 RETURNING id, name, email, is_active',
    [req.params.id, req.user!.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Guard not found' });
  res.json(result.rows[0]);
});

router.post('/:id/assign', requireAuth('company_admin'), async (req, res) => {
  const { site_id, assigned_from, assigned_until } = req.body;

  // Bycatch from Phase A audit: tenant-scope the GUARD too (the prior
  // version only verified site_id was in caller's company, leaving a
  // company_admin able to assign their site to a guard owned by a
  // different company).
  const guardCheck = await pool.query(
    'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  if (!guardCheck.rows[0]) return res.status(403).json({ error: 'Guard not found' });

  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  // Phase B — write the assign + audit row in one transaction so a partial
  // failure can't leave a row without history.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from, assigned_until)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, site_id, assigned_from, assigned_until || null]
    );
    const row = result.rows[0];
    await writeAssignmentAudit(client, {
      assignmentId: row.id,
      action: 'guard_assignment_created',
      changedBy: req.user!.sub,
      before: null,
      after: row,
    });
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    // uq_guard_site_active: (guard_id, site_id, assigned_from)
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Assignment with this start date already exists.' });
    }
    console.error('[POST /api/guards/:id/assign] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to assign guard' });
  } finally {
    client.release();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Phase B — assignment edit / remove / impact endpoints.
//
// All three are scoped under :guardId so the tenant check is uniform: the
// guard must belong to the caller's company (vishnu has no company scope
// and can touch any). The assignment id is then matched against (id,
// guard_id) so an admin can't operate on another guard's row by guessing
// UUIDs.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tenant gate shared by the three :guardId/assignments/* endpoints.
 * Returns null on success, otherwise the (status, body) tuple to send.
 */
async function guardBelongsToCaller(
  req: import('express').Request,
): Promise<{ status: number; body: { error: string } } | null> {
  if (req.user!.role === 'vishnu') return null; // vishnu has no company scope
  const r = await pool.query(
    'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
    [req.params.guardId, req.user!.company_id],
  );
  if (!r.rows[0]) return { status: 403, body: { error: 'Guard not found' } };
  return null;
}

// PATCH /api/guards/:guardId/assignments/:id
router.patch('/:guardId/assignments/:id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const tenantErr = await guardBelongsToCaller(req);
  if (tenantErr) return res.status(tenantErr.status).json(tenantErr.body);

  const { assigned_until } = req.body as { assigned_until?: string | null };
  // Validate the incoming value's shape but defer "no past dates" /
  // "no inverted window" to the post-load checks (they need assigned_from).
  if (assigned_until !== null && assigned_until !== undefined) {
    if (typeof assigned_until !== 'string' || !YYYY_MM_DD.test(assigned_until)) {
      return res.status(400).json({ error: 'assigned_until must be YYYY-MM-DD or null' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowRes = await client.query(
      `SELECT * FROM guard_site_assignments
        WHERE id = $1 AND guard_id = $2
        FOR UPDATE`,
      [req.params.id, req.params.guardId],
    );
    if (!rowRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const before = rowRes.rows[0];

    // The PATCH body either supplies assigned_until or doesn't. Treat
    // "undefined" the same as "no-op" (current value preserved). Use
    // hasOwnProperty so we can distinguish null from missing — null means
    // "reopen the window."
    const nextUntil = Object.prototype.hasOwnProperty.call(req.body, 'assigned_until')
      ? (assigned_until ?? null)
      : before.assigned_until;

    if (nextUntil !== null) {
      // YYYY-MM-DD comparison vs the row's assigned_from. pg deserialises
      // a DATE column to a JS Date at UTC midnight — Date.toString() then
      // emits "Wed Jun 11 2026 …" which corrupts a lexicographic
      // comparison with a YYYY-MM-DD string ('2' < 'W' so any future date
      // would wrongly compare as "before" assigned_from). Normalize the
      // before-value through toISOString.
      const fromStr = before.assigned_from instanceof Date
        ? before.assigned_from.toISOString().slice(0, 10)
        : String(before.assigned_from).slice(0, 10);
      if (nextUntil < fromStr) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'assigned_until cannot precede assigned_from.' });
      }
      if (isPastPacificDateString(nextUntil)) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'assigned_until cannot be in the past.' });
      }
    }

    const updateRes = await client.query(
      `UPDATE guard_site_assignments
          SET assigned_until = $1
        WHERE id = $2
        RETURNING *`,
      [nextUntil, req.params.id],
    );
    const after = updateRes.rows[0];

    await writeAssignmentAudit(client, {
      assignmentId: after.id,
      action: 'guard_assignment_ended',
      changedBy: req.user!.sub,
      before,
      after,
    });

    await client.query('COMMIT');
    res.json(after);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[PATCH /api/guards/:guardId/assignments/:id] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to update assignment' });
  } finally {
    client.release();
  }
});

// DELETE /api/guards/:guardId/assignments/:id
router.delete('/:guardId/assignments/:id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const tenantErr = await guardBelongsToCaller(req);
  if (tenantErr) return res.status(tenantErr.status).json(tenantErr.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowRes = await client.query(
      `SELECT * FROM guard_site_assignments
        WHERE id = $1 AND guard_id = $2
        FOR UPDATE`,
      [req.params.id, req.params.guardId],
    );
    if (!rowRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const before = rowRes.rows[0];

    // Audit FIRST, then delete. The audit row has no FK on assignment_id
    // (see schema_v20 comment), so the snapshot in `before` survives even
    // though the parent row is about to disappear.
    await writeAssignmentAudit(client, {
      assignmentId: before.id,
      action: 'guard_assignment_removed',
      changedBy: req.user!.sub,
      before,
      after: null,
    });
    await client.query(`DELETE FROM guard_site_assignments WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[DELETE /api/guards/:guardId/assignments/:id] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to remove assignment' });
  } finally {
    client.release();
  }
});

// GET /api/guards/:guardId/assignments/:id/impact
//
// SCOPE: ONE ASSIGNMENT — that is, this guard's link to ONE site — being
// ended or removed. It is NOT the guard-level question; for that see
// GET /:guardId/deactivation-impact above, which spans every site, uses
// scheduled_end > NOW() rather than scheduled_start > NOW(), and rides
// alongside a real server-side block.
//
// Reports the future-shifts blast radius an admin would lose visibility
// over by ending or removing this assignment. No server-side block —
// grandfather principle — the UI uses this purely to surface a warning.
// That grandfather principle applies to ASSIGNMENT REMOVAL ONLY and says
// nothing about deactivation, which does block on an open session.
router.get('/:guardId/assignments/:id/impact', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const tenantErr = await guardBelongsToCaller(req);
  if (tenantErr) return res.status(tenantErr.status).json(tenantErr.body);

  const rowRes = await pool.query(
    `SELECT id, site_id FROM guard_site_assignments
      WHERE id = $1 AND guard_id = $2`,
    [req.params.id, req.params.guardId],
  );
  if (!rowRes.rows[0]) return res.status(404).json({ error: 'Assignment not found' });
  const { site_id } = rowRes.rows[0];

  const futureRes = await pool.query(
    `SELECT (scheduled_start AT TIME ZONE 'America/Los_Angeles')::date AS d
       FROM shifts
      WHERE guard_id = $1
        AND site_id  = $2
        AND scheduled_start > NOW()
        AND status IN ('scheduled', 'active')
      ORDER BY scheduled_start ASC`,
    [req.params.guardId, site_id],
  );

  // pg deserialises DATE columns to JS Date — see PATCH handler for the
  // toString() pitfall. Normalize via toISOString() so the API returns
  // proper YYYY-MM-DD strings (which the web modal then renders verbatim).
  const dates = futureRes.rows.map(r => r.d instanceof Date
    ? r.d.toISOString().slice(0, 10)
    : String(r.d).slice(0, 10));
  res.json({
    future_shift_count: dates.length,
    sample_dates: dates.slice(0, 5),
  });
});

// GET /api/guards/:id/assigned-sites?date=YYYY-MM-DD
//
// Powers the /admin/shifts modal: when an admin picks a guard, the SITE
// dropdown is filtered to that guard's currently-active assignments. The
// date param defaults to today's Pacific calendar date; the modal sends
// the current date when fetching, and server-side enforcement in the
// shift POST handler re-validates per emitted shift date so the dropdown
// is purely a UI convenience.
router.get('/:id/assigned-sites', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const dateParam = (req.query.date as string | undefined) ?? pacificTodayStr();
  if (!YYYY_MM_DD.test(dateParam)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  // Tenant gate. vishnu has no company scope and may read any guard's
  // assignments; company_admin can only read guards in their own company.
  if (req.user!.role === 'company_admin') {
    const guardCheck = await pool.query(
      'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user!.company_id]
    );
    if (!guardCheck.rows[0]) return res.status(404).json({ error: 'Guard not found' });
  }

  const sites = await getAssignedSitesForGuard(req.params.id, dateParam);
  res.json({ date: dateParam, sites });
});

export default router;
