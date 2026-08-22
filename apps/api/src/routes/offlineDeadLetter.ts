/**
 * Offline dead-letter escalation.
 *
 * ── WHAT THIS RECORDS ───────────────────────────────────────────────────
 *
 * "A guard's device attempted a write, told the guard it had been saved,
 * and it never landed." A row here is a record of a FAILURE. None of the
 * payload was ever validated by this API, so nothing in it may be read as
 * though it were a real scan or report.
 *
 * ── WHY IT IS NOT AN ACCUSATION ─────────────────────────────────────────
 *
 * The overwhelmingly likely cause is bad connectivity, which is a property
 * of the building, not the guard. Any admin UI built on this must read as
 * "these did not make it". Same discipline as location_integrity_flags:
 * no auto-escalation, no email, no push. A human looks and decides.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────
 *
 * guard_id is ALWAYS req.user.sub and NEVER read from the body — a guard
 * cannot file a loss against another guard. company_id is resolved inside
 * the INSERT from guards.company_id, so it cannot be supplied or spoofed,
 * and a request from a guard row that has vanished inserts nothing rather
 * than inventing a tenant.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();

/**
 * Server-side batch cap. The client also caps, but a client cap is a
 * request, not a guarantee. Excess items are NOT an error: they are left
 * for the next sweep, because the client only marks the localIds this
 * response acknowledges. Silently dropping them would be the "no silent
 * caps" failure, so the response reports what was left behind.
 */
const MAX_BATCH = 20;

/** A queue payload is a report body or a scan body — kilobytes at most.
 *  Anything larger is malformed or hostile; store a marker instead of the
 *  blob so one bad item cannot bloat the table. */
const MAX_PAYLOAD_BYTES = 32 * 1024;

const VALID_REASONS = new Set(['permanent_4xx', 'max_attempts', 'unknown_type']);

interface IncomingItem {
  local_id?:    unknown;
  action_type?: unknown;
  dead_reason?: unknown;
  dead_status?: unknown;
  queued_at?:   unknown;
  dead_at?:     unknown;
  last_error?:  unknown;
  payload?:     unknown;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

function iso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// POST /api/offline/dead-letter — a device reporting writes it gave up on.
//
// Idempotent on (guard_id, local_id): the client sweep retries until this
// endpoint acknowledges, so the same item WILL arrive more than once.
router.post('/dead-letter', requireAuth('guard'), async (req, res) => {
  const guardId = req.user!.sub;               // never from the body
  const client  = str(req.get('X-NetraOps-Client'), 200);

  const raw = (req.body as { items?: unknown })?.items;
  if (!Array.isArray(raw)) {
    return res.status(400).json({ error: 'ITEMS_REQUIRED', message: 'items must be an array' });
  }

  const batch   = raw.slice(0, MAX_BATCH);
  const deferred = raw.length - batch.length;
  if (deferred > 0) {
    console.log(`dead_letter.batch_capped guard=${guardId} sent=${raw.length} took=${batch.length} deferred=${deferred}`);
  }

  const accepted: string[] = [];
  const rejected: { local_id: string | null; why: string }[] = [];

  for (const item of batch as IncomingItem[]) {
    const localId    = str(item?.local_id, 64);
    const actionType = str(item?.action_type, 40);
    const reason     = str(item?.dead_reason, 24);

    if (!localId)                       { rejected.push({ local_id: null, why: 'local_id' });     continue; }
    if (!actionType)                    { rejected.push({ local_id: localId, why: 'action_type' }); continue; }
    if (!reason || !VALID_REASONS.has(reason)) { rejected.push({ local_id: localId, why: 'dead_reason' }); continue; }

    let payload: unknown = item?.payload ?? null;
    try {
      if (payload !== null && Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
        payload = { _truncated: true, _reason: 'payload exceeded MAX_PAYLOAD_BYTES' };
      }
    } catch {
      payload = { _truncated: true, _reason: 'payload not serialisable' };
    }

    const status = typeof item?.dead_status === 'number' && Number.isFinite(item.dead_status)
      ? Math.trunc(item.dead_status) : null;

    try {
      // company_id comes from the guards row, not the request. If the guard
      // no longer exists the SELECT yields no row and nothing is inserted —
      // it cannot fabricate a tenant.
      await pool.query(
        `INSERT INTO offline_dead_letters
           (local_id, guard_id, company_id, action_type, dead_reason, dead_status,
            queued_at, dead_at, last_error, payload, client)
         SELECT $1, g.id, g.company_id, $2, $3, $4, $5, $6, $7, $8, $9
           FROM guards g WHERE g.id = $10
         ON CONFLICT (guard_id, local_id) DO NOTHING`,
        [
          localId, actionType, reason, status,
          iso(item?.queued_at), iso(item?.dead_at),
          str(item?.last_error, 2000),
          payload === null ? null : JSON.stringify(payload),
          client, guardId,
        ],
      );
      // Acknowledged whether the row was new or already present — an
      // idempotent replay must let the device stop retrying.
      accepted.push(localId);
    } catch (err) {
      // One bad item must never fail the batch: the rest are real losses
      // and the device needs to stop carrying them.
      console.error(`dead_letter.insert_failed guard=${guardId} local_id=${localId}:`, err);
      rejected.push({ local_id: localId, why: 'server' });
    }
  }

  console.log(
    `dead_letter.report guard=${guardId} accepted=${accepted.length} ` +
    `rejected=${rejected.length} deferred=${deferred} client=${client ?? 'unknown'}`,
  );

  res.status(200).json({ accepted, rejected, deferred, max_batch: MAX_BATCH });
});

// GET /api/offline/dead-letter — admin list.
//   ?status=open|reviewed|all  (default open)
//   ?limit= (default 100, max 500)
//
// Tenant scoping joins guards and filters g.company_id, matching
// location_integrity_flags. The denormalised company_id on the row records
// the tenant at report time; the JOIN is what authorises the read.
router.get('/dead-letter', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const status = String(req.query.status ?? 'open');
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);

  const where: string[] = [];
  const params: unknown[] = [];

  if (req.user!.role === 'company_admin') {
    params.push(req.user!.company_id);
    where.push(`g.company_id = $${params.length}`);
  }
  if (status === 'open') where.push('d.reviewed_at IS NULL');
  else if (status === 'reviewed') where.push('d.reviewed_at IS NOT NULL');

  params.push(limit);

  const rows = await pool.query(
    `SELECT d.id, d.local_id, d.action_type, d.dead_reason, d.dead_status,
            d.queued_at, d.dead_at, d.payload, d.client, d.reported_at,
            d.reviewed_at, d.reviewed_by, d.review_note,
            g.id AS guard_id, g.name AS guard_name, g.badge_number
       FROM offline_dead_letters d
       JOIN guards g ON g.id = d.guard_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.reviewed_at IS NOT NULL, d.reported_at DESC
      LIMIT $${params.length}`,
    params,
  );

  res.json({
    items: rows.rows,
    caveat: {
      meaning:
        'Each row is a write a guard’s device attempted, reported as saved to the guard, ' +
        'and never delivered. The payload was never validated by the API and is not a record ' +
        'that the underlying event occurred.',
      not_misconduct:
        'The usual cause is poor connectivity at the site. These are not indications of ' +
        'guard behaviour and must not be presented as such.',
      coverage:
        'Only devices running the dead-letter build report here, and only while they have ' +
        'connectivity to report. Losses on older builds, or on a device that was reinstalled, ' +
        'never appear. An empty list is not proof that nothing was lost.',
    },
  });
});

export default router;
