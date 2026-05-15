/**
 * Activity Log — unified feed of pings (with missed/late synthesized rows)
 * and full reports (activity / incident / maintenance). Drives the admin
 * "Activity Log" page and the client portal's site activity view.
 *
 * GET /api/activity-log
 *   ?from=ISO  (default: now - 7 days)
 *   ?to=ISO    (default: now)
 *   ?guard_id=UUID         (company_admin only)
 *   ?page=1
 *   ?page_size=10          (max 100)
 *
 * Scope:
 *   - company_admin → all shift_sessions within the company
 *   - client        → shift_sessions at the client's site
 *
 * Window anchoring: UTC half-hours (every :00 and :30) — matches the
 * reminder cron. Each window is [W, W+30min). A window appears in the
 * feed once it's "complete" — either the session ended OR the next
 * window has already started.
 *
 * Status rules:
 *   - No ping in window           → "Missed Ping"
 *   - Ping arrived < 10 min late  → "Ping (X minutes)"
 *   - Ping arrived ≥ 10 min late  → "Late Ping (X minutes)"
 *
 * Pagination is computed after merge+sort in memory. Fine for typical
 * volumes (a few hundred rows); revisit if it grows.
 */
import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';

const router = Router();

const WINDOW_MIN = 30;
const LATE_THRESHOLD_MIN = 10;

interface SessionRow {
  session_id:     string;
  guard_id:       string;
  guard_name:     string;
  site_id:        string;
  site_name:      string;
  clocked_in_at:  string;
  clocked_out_at: string | null;
}

interface PingRow {
  id:                string;
  shift_session_id:  string;
  pinged_at:         string;
  photo_url:         string | null;
  latitude:          number;
  longitude:         number;
}

interface ReportRow {
  id:           string;
  report_type:  'activity' | 'incident' | 'maintenance';
  reported_at:  string;
  guard_id:     string;
  guard_name:   string;
  site_id:      string;
  site_name:    string;
  photos:       string[] | null;
}

type StatusKind = 'on_time' | 'late' | 'missed' | 'activity_report' | 'incident_report' | 'maintenance_report';

export interface ActivityRow {
  id:             string;
  kind:           'ping' | 'report';
  guard_id:       string;
  guard_name:     string;
  site_id:        string;
  site_name:      string;
  status:         string;
  status_kind:    StatusKind;
  log_time:       string | null;
  log_media_url:  string | null;
  event_time:     string;        // used for sort + ordering only
  detail_id:      string | null; // ping id or report id; null for synthesized missed rows
}

/** Round up to the next UTC :00 or :30 boundary. */
function nextHalfHour(ms: number): number {
  const d = new Date(ms);
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  const mins = d.getUTCMinutes();
  if (mins === 0 || mins === 30) {
    d.setUTCMinutes(mins + 30);
  } else if (mins < 30) {
    d.setUTCMinutes(30);
  } else {
    d.setUTCMinutes(0);
    d.setUTCHours(d.getUTCHours() + 1);
  }
  return d.getTime();
}

function buildPingStatus(deltaMin: number): { text: string; kind: 'on_time' | 'late' } {
  const m = Math.max(0, Math.round(deltaMin));
  const plural = m === 1 ? 'minute' : 'minutes';
  if (m < LATE_THRESHOLD_MIN) return { text: `Ping (${m} ${plural})`, kind: 'on_time' };
  return { text: `Late Ping (${m} ${plural})`, kind: 'late' };
}

router.get('/', requireAuth('company_admin', 'client'), async (req: Request, res: Response) => {
  const { from, to, guard_id, page = '1', page_size = '10' } = req.query;
  const pageNum  = Math.max(1, parseInt(page as string, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(page_size as string, 10) || 10));
  const offset   = (pageNum - 1) * pageSize;

  const fromIso = (from as string) || new Date(Date.now() - 7 * 86_400_000).toISOString();
  const toIso   = (to   as string) || new Date().toISOString();
  const fromMs  = Date.parse(fromIso);
  const toMs    = Date.parse(toIso);

  // ── Scope filter ─────────────────────────────────────────────────────────
  const { user } = req;
  let scopeWhere: string;
  let scopeParams: unknown[];
  if (user!.role === 'client') {
    scopeWhere  = 'ss.site_id = $1';
    scopeParams = [user!.site_id];
  } else {
    scopeWhere  = 'si.company_id = $1';
    scopeParams = [user!.company_id];
  }

  // ── Pull every shift_session that overlaps [fromIso, toIso] ──────────────
  let sessionQuery = `
    SELECT
      ss.id              AS session_id,
      ss.guard_id,
      g.name             AS guard_name,
      ss.site_id,
      si.name            AS site_name,
      ss.clocked_in_at,
      ss.clocked_out_at
    FROM shift_sessions ss
    JOIN guards g ON g.id = ss.guard_id
    JOIN sites  si ON si.id = ss.site_id
    WHERE ${scopeWhere}
      AND ss.clocked_in_at < $${scopeParams.length + 1}
      AND COALESCE(ss.clocked_out_at, NOW()) > $${scopeParams.length + 2}`;
  const sessionParams: unknown[] = [...scopeParams, toIso, fromIso];

  if (guard_id && user!.role === 'company_admin') {
    sessionQuery += ` AND ss.guard_id = $${sessionParams.length + 1}`;
    sessionParams.push(guard_id);
  }
  const sessionsResult = await pool.query<SessionRow>(sessionQuery, sessionParams);
  const sessions = sessionsResult.rows;

  // ── Pull pings for those sessions in range ───────────────────────────────
  const sessionIds = sessions.map((s) => s.session_id);
  const pings: PingRow[] = [];
  if (sessionIds.length > 0) {
    const pingsResult = await pool.query<PingRow>(
      `SELECT id, shift_session_id, pinged_at, photo_url, latitude, longitude
       FROM location_pings
       WHERE shift_session_id = ANY($1::uuid[])
         AND pinged_at >= $2
         AND pinged_at <= $3
       ORDER BY pinged_at ASC`,
      [sessionIds, fromIso, toIso],
    );
    pings.push(...pingsResult.rows);
  }

  // ── Pull reports in range (scoped) ───────────────────────────────────────
  let reportQuery = `
    SELECT
      r.id,
      r.report_type,
      r.reported_at,
      ss.guard_id,
      g.name AS guard_name,
      r.site_id,
      si.name AS site_name,
      array_agg(rp.storage_url ORDER BY rp.photo_index) FILTER (WHERE rp.id IS NOT NULL) AS photos
    FROM reports r
    JOIN shift_sessions ss ON ss.id = r.shift_session_id
    JOIN guards g  ON g.id  = ss.guard_id
    JOIN sites  si ON si.id = r.site_id
    LEFT JOIN report_photos rp ON rp.report_id = r.id
    WHERE ${scopeWhere}
      AND r.reported_at >= $${scopeParams.length + 1}
      AND r.reported_at <= $${scopeParams.length + 2}`;
  const reportParams: unknown[] = [...scopeParams, fromIso, toIso];

  if (guard_id && user!.role === 'company_admin') {
    reportQuery += ` AND ss.guard_id = $${reportParams.length + 1}`;
    reportParams.push(guard_id);
  }
  reportQuery += ' GROUP BY r.id, ss.guard_id, g.name, si.name';
  const reportsResult = await pool.query<ReportRow>(reportQuery, reportParams);

  // ── Build merged feed ────────────────────────────────────────────────────
  const rows: ActivityRow[] = [];

  // Group pings by session for fast lookup
  const pingsBySession = new Map<string, PingRow[]>();
  for (const p of pings) {
    const arr = pingsBySession.get(p.shift_session_id) ?? [];
    arr.push(p);
    pingsBySession.set(p.shift_session_id, arr);
  }

  const nowMs = Date.now();

  for (const s of sessions) {
    const sessionStartMs = Date.parse(s.clocked_in_at);
    const sessionEndMs   = s.clocked_out_at ? Date.parse(s.clocked_out_at) : nowMs;
    const sessionPings   = pingsBySession.get(s.session_id) ?? [];

    let windowStart = nextHalfHour(sessionStartMs);
    while (windowStart < sessionEndMs) {
      const windowEnd = windowStart + WINDOW_MIN * 60_000;

      // Window must be complete (next window has begun, or shift has ended).
      const isComplete = windowEnd <= Math.min(nowMs, sessionEndMs);
      if (!isComplete) break;

      // Date range filter: skip windows outside [fromMs, toMs]
      if (windowEnd > fromMs && windowStart < toMs) {
        const ping = sessionPings.find((p) => {
          const pt = Date.parse(p.pinged_at);
          return pt >= windowStart && pt < windowEnd;
        });

        if (ping) {
          const deltaMin = (Date.parse(ping.pinged_at) - windowStart) / 60_000;
          const status   = buildPingStatus(deltaMin);
          rows.push({
            id:            ping.id,
            kind:          'ping',
            guard_id:      s.guard_id,
            guard_name:    s.guard_name,
            site_id:       s.site_id,
            site_name:     s.site_name,
            status:        status.text,
            status_kind:   status.kind,
            log_time:      ping.pinged_at,
            log_media_url: ping.photo_url,
            event_time:    ping.pinged_at,
            detail_id:     ping.id,
          });
        } else {
          rows.push({
            id:            `missed-${s.session_id}-${windowStart}`,
            kind:          'ping',
            guard_id:      s.guard_id,
            guard_name:    s.guard_name,
            site_id:       s.site_id,
            site_name:     s.site_name,
            status:        'Missed Ping',
            status_kind:   'missed',
            log_time:      null,
            log_media_url: null,
            event_time:    new Date(windowStart).toISOString(),
            detail_id:     null,
          });
        }
      }

      windowStart = windowEnd;
    }
  }

  // Add report rows
  for (const r of reportsResult.rows) {
    const typeName = r.report_type.charAt(0).toUpperCase() + r.report_type.slice(1);
    rows.push({
      id:            r.id,
      kind:          'report',
      guard_id:      r.guard_id,
      guard_name:    r.guard_name,
      site_id:       r.site_id,
      site_name:     r.site_name,
      status:        `${typeName} Report`,
      status_kind:   `${r.report_type}_report` as StatusKind,
      log_time:      r.reported_at,
      log_media_url: r.photos?.[0] ?? null,
      event_time:    r.reported_at,
      detail_id:     r.id,
    });
  }

  // Newest first
  rows.sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));

  // Paginate in memory
  const total    = rows.length;
  const pageRows = rows.slice(offset, offset + pageSize);

  res.json({
    rows:        pageRows,
    total,
    page:        pageNum,
    page_size:   pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

export default router;
