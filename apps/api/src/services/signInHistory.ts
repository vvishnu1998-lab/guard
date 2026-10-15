/**
 * Phase D, part D1: an admin's own sign-in history.
 *
 * Vishnu's decisions, 2026-10-14, within the one locked on 2026-10-06 (6a: own
 * history only, no IP column):
 * - 1b: sign-ins, failed sign-ins, lockouts, password changes and password
 *   reset emails; and, since N202 (decision 4a, 2026-10-14) made the web's SIGN
 *   OUT end the session on the server and record it, sign-outs;
 * - 2a: its own page, newest first, 50 at a time, back to auth_events'
 *   retention.
 *
 * Read from auth_events, which the auth routes already write. The rows are the
 * caller's own: actor_id is the token's subject and the role is company_admin.
 * The answer carries the time, the event and a device name, never the address
 * or the raw user agent.
 *
 * Pages are keyed on (created_at, id). The cursor keeps created_at to the
 * microsecond, as Postgres stores it: a JavaScript Date keeps milliseconds, and
 * a cursor cut to them would skip the rows that share the millisecond.
 */
import { pool } from '../db/pool';
import { deviceLabel } from './deviceLabel';

export const SIGN_IN_EVENT_TYPES = ['login_success', 'login_failed', 'login_blocked_locked', 'password_changed', 'password_reset_emailed', 'logout'] as const;
export const SIGN_IN_PAGE_SIZE = 50;
/** auth_events' retention (PURGE_DAYS.AUTH_EVENTS in jobs/nightlyPurge.ts), so a row about to be purged is never shown. */
export const SIGN_IN_HISTORY_DAYS = 365;

export interface SignInEvent {
  /** ISO instant, to the millisecond. */
  at: string;
  type: (typeof SIGN_IN_EVENT_TYPES)[number];
  device: string;
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** `?before=` as the page gave it: absent (the first page), a cursor, or 'invalid'. */
export function parseCursor(raw: unknown): { at: string; id: string } | null | 'invalid' {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') return 'invalid';
  const m = CURSOR.exec(raw);
  return m ? { at: m[1], id: m[2] } : 'invalid';
}

export async function signInHistory(adminId: string, before: { at: string; id: string } | null): Promise<{ events: SignInEvent[]; next: string | null }> {
  const r = await pool.query(
    `SELECT id, created_at, event_type, user_agent,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact
       FROM auth_events
      WHERE actor_id = $1
        AND role = 'company_admin'
        AND event_type = ANY($2::text[])
        AND created_at > NOW() - make_interval(days => $3)
        AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $6`,
    [adminId, SIGN_IN_EVENT_TYPES, SIGN_IN_HISTORY_DAYS, before?.at ?? null, before?.id ?? null, SIGN_IN_PAGE_SIZE + 1],
  );
  const rows = r.rows.slice(0, SIGN_IN_PAGE_SIZE);
  const last = rows[rows.length - 1];
  return {
    events: rows.map((row: { created_at: Date; event_type: SignInEvent['type']; user_agent: string | null }) => ({
      at: new Date(row.created_at).toISOString(),
      type: row.event_type,
      device: deviceLabel(row.user_agent),
    })),
    next: r.rows.length > SIGN_IN_PAGE_SIZE ? `${last.exact}_${last.id}` : null,
  };
}
