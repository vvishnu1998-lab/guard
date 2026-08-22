/**
 * Location integrity review queue — ADMIN, READ-ONLY LIST + REVIEW STATE.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────
 *
 * Not a blocking path. Not consulted on any guard request. Never returns a
 * 4xx to a guard — no guard-facing route exists here at all. Every route is
 * behind company_admin / vishnu auth.
 *
 * A flag means "a human should look at this". It is not a finding, and the
 * API must never present it as one.
 *
 * ── THE HONEST LIMIT — surfaced in the response, deliberately ───────────
 *
 * A mock set to a coordinate never otherwise recorded, with plausible
 * accuracy and jitter, defeats every check that writes to this table. The
 * list response carries that caveat inline so a reader of the admin UI
 * cannot mistake an empty queue for an all-clear.
 *
 * iOS is not covered by the underlying signal at all — see
 * services/locationIntegrity.ts.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();

/** Shipped alongside every list response. An empty queue is not an
 *  all-clear and the UI must not render it as one. */
const CAVEAT = {
  coverage:
    'Advisory only. These checks detect naive location simulation. A simulated position ' +
    'set to a coordinate never otherwise recorded, with plausible accuracy, is not detectable ' +
    'by any check here — an empty queue is not an all-clear.',
  checks_are_not_interchangeable:
    'Verified by controlled reproduction 2026-08-22: the monotonicity check does NOT fire on a ' +
    'single uninterrupted simulated burst — it detects a coordinate reappearing after a newer ' +
    'fix, which requires interleaving with genuine fixes. In that case the accuracy-sentinel ' +
    'check carries the entire detection, and it recognises exactly ONE tool. A different tool ' +
    'with plausible accuracy and jitter defeats BOTH checks.',
  platform:
    'The underlying OS signal (location_mocked) is Android-only. iOS devices report nothing ' +
    'and are not covered.',
  false_positive_rate:
    'Unknown. There is no labelled-negative dataset, so no false-positive rate has been ' +
    'established. Treat every row as a question, not an answer.',
};

// GET /api/location-integrity — review queue.
//   ?status=open|reviewed|all   (default open)
//   ?limit=  (default 100, max 500)
router.get('/', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const status = String(req.query.status ?? 'open');
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);

  const where: string[] = [];
  const params: unknown[] = [];

  // company_admin sees only their own tenant. vishnu sees everything.
  if (req.user!.role === 'company_admin') {
    params.push(req.user!.company_id);
    where.push(`g.company_id = $${params.length}`);
  }
  if (status === 'open') where.push('f.reviewed_at IS NULL');
  else if (status === 'reviewed') where.push('f.reviewed_at IS NOT NULL');

  params.push(limit);

  const rows = await pool.query(
    `SELECT f.id, f.shift_session_id, f.check_name, f.evidence,
            f.detected_at, f.first_event_at, f.last_event_at,
            f.reviewed_at, f.reviewed_by, f.review_outcome, f.review_note,
            g.id AS guard_id, g.name AS guard_name, g.badge_number,
            s.id AS site_id, s.name AS site_name,
            ss.clocked_in_at, ss.clocked_out_at
       FROM location_integrity_flags f
       JOIN guards g ON g.id = f.guard_id
       JOIN sites  s ON s.id = f.site_id
       JOIN shift_sessions ss ON ss.id = f.shift_session_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY f.reviewed_at IS NOT NULL, f.detected_at DESC
      LIMIT $${params.length}`,
    params,
  );

  res.json({ flags: rows.rows, caveat: CAVEAT });
});

// PATCH /api/location-integrity/:id/review — record a human decision.
// The only write in this file. Once set, the nightly job leaves the row
// alone (ON CONFLICT DO NOTHING on the unique index), so a dismissed flag
// stays dismissed.
router.patch('/:id/review', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { outcome, note } = req.body as { outcome?: string; note?: string };
  if (!['dismissed', 'confirmed', 'escalated'].includes(String(outcome))) {
    return res.status(400).json({ error: 'outcome must be dismissed, confirmed or escalated' });
  }

  const params: unknown[] = [outcome, note ?? null, req.user!.sub, req.params.id];
  let tenantClause = '';
  if (req.user!.role === 'company_admin') {
    params.push(req.user!.company_id);
    tenantClause = ` AND f.guard_id IN (SELECT id FROM guards WHERE company_id = $${params.length})`;
  }

  const upd = await pool.query(
    `UPDATE location_integrity_flags f
        SET review_outcome = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW()
      WHERE f.id = $4${tenantClause}
      RETURNING f.id, f.review_outcome, f.reviewed_at`,
    params,
  );

  if (!upd.rows[0]) return res.status(404).json({ error: 'Flag not found' });
  res.json(upd.rows[0]);
});

export default router;
