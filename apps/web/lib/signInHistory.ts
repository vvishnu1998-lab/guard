/**
 * Phase D, D1: the words and times on the admin's sign-in history page
 * (Vishnu's decisions 1b and 2a, 2026-10-14).
 *
 * Times are shown in Pacific time, the zone of every site, whatever zone the
 * browser is in, and say so ("PT"). The weekday is computed from the Pacific
 * calendar date, never from the instant in another zone: 9 PM on Wednesday
 * 14 October 2026 in Los Angeles is already Thursday in UTC.
 */

/** One row of GET /api/admin/me/sign-ins. */
export interface SignInEvent {
  at: string;
  type: string;
  device: string;
}

/** 1b: the five events the history lists. A type this page does not know is shown as sent. */
export const SIGN_IN_EVENT_LABELS: Record<string, string> = {
  login_success: 'Signed in',
  login_failed: 'Failed sign-in',
  login_blocked_locked: 'Sign-in blocked: too many failed attempts',
  password_changed: 'Password changed',
  password_reset_emailed: 'Password reset email sent',
};

export function signInEventLabel(type: string): string {
  return SIGN_IN_EVENT_LABELS[type] ?? type;
}

/** A failed or blocked sign-in, which the page marks so it stands out. */
export function isSignInFailure(type: string): boolean {
  return type === 'login_failed' || type === 'login_blocked_locked';
}

export const HISTORY_ZONE = 'America/Los_Angeles';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/**
 * "Wed 14 Oct 2026, 14:06 PT". The Pacific calendar date and clock come from
 * Intl in that zone; the weekday from that calendar date on a UTC midnight, so
 * no zone can move it; 24-hour, like the rest of the admin app.
 */
export function fmtPacific(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HISTORY_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const part = (t: string) => parts.filter((p) => p.type === t).map((p) => p.value)[0] || '';
  const y = Number(part('year'));
  const m = Number(part('month'));
  const d = Number(part('day'));
  if (!y || !m || !d) return iso;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}, ${part('hour')}:${part('minute')} PT`;
}
