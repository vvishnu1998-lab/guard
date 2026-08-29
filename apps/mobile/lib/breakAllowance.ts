/**
 * Break allowance — pure interpretation of what GET /shifts/active-session
 * says about whether a break can start, and when.
 *
 * Extracted from app/break/index.tsx so it can be exercised without mounting
 * a React tree or an Expo runtime. The screen imports it; nothing here
 * touches React, navigation, or the network.
 */
import { DEFAULT_SITE_TZ } from './pingSchedule';

/**
 * The allowance the server reports on GET /shifts/active-session, once we
 * have decided we understand it.
 */
export interface Allowance {
  used: number;
  limit: number;
  canStart: boolean;
  eligibleAt: Date | null;
  reason: string | null;
}

/**
 * Read `break_quotas` off the active-session payload, or return null meaning
 * "no usable information — fail open".
 *
 * ── BOTH DIRECTIONS OF SKEW (this is the whole point) ───────────────────
 *
 * A build from this branch can install BEFORE the API deploys, so this
 * screen WILL meet the old shape in the field — that is the likelier skew,
 * not the exotic one. The two shapes are:
 *
 *   OLD (deployed today)  { meal:{used,limit}, rest:{...}, other:{...} }
 *   NEW                   { used, limit, can_start, eligible_at, reason }
 *
 * We accept ONLY the new shape, recognised by numeric top-level `used` and
 * `limit`. The old per-type map has neither, so it falls through to null and
 * the screen renders no allowance line and disables nothing. That is correct
 * rather than merely safe: under one break type the old map has no
 * interpretation — there is no "break" key in it, and picking meal's 1 or
 * rest's 2 would be inventing a number the server never said.
 *
 * The mirror direction (old bundle, new API) is handled on the other side:
 * an old build reads breakQuotas?.['meal'], gets undefined, and its own
 * `?? null` fails it open the same way.
 *
 * Malformed, absent, wrong types, unparseable eligible_at — all null. The
 * server's 422 is the only real enforcement in every one of these cases.
 */
export function parseAllowance(raw: unknown): Allowance | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.used !== 'number' || !Number.isFinite(o.used)) return null;
  if (typeof o.limit !== 'number' || !Number.isFinite(o.limit)) return null;

  let eligibleAt: Date | null = null;
  if (typeof o.eligible_at === 'string') {
    const d = new Date(o.eligible_at);
    if (!Number.isNaN(d.getTime())) eligibleAt = d;
  }
  return {
    used:  o.used,
    limit: o.limit,
    // Absent can_start on an otherwise-valid payload → treat as startable.
    // Fail OPEN: a guard wrongly blocked by a client-side guess cannot take a
    // legally-required break, which is worse than a 422 they can read.
    canStart:   o.can_start !== false,
    eligibleAt,
    reason: typeof o.reason === 'string' ? o.reason : null,
  };
}

/**
 * "7:30 PM" for a blocked-until time.
 *
 * TIMEZONE: site-local, via the same DEFAULT_SITE_TZ fallback the ping
 * labels use (lib/pingSchedule.ts). GET /shifts/active-session does not carry
 * site_tz — plumbing it through is a one-line API change that has not been
 * made — so this is the site zone by assumption, not by data. Every site on
 * the platform today is America/Los_Angeles, so the fallback and the real
 * value coincide; the day that stops being true this string is wrong for the
 * odd site, and the fix is to send site_tz. Deliberately NOT device-local:
 * a guard's phone in another zone would render a time the server never meant.
 */
export function siteLocalClock(when: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: DEFAULT_SITE_TZ,
    }).format(when);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(when);
  }
}

/** The line under the card when a break cannot be started right now. */
export function blockedCopy(a: Allowance): string {
  const at = a.eligibleAt ? siteLocalClock(a.eligibleAt) : null;
  switch (a.reason) {
    case 'BREAK_QUOTA_EXCEEDED': return 'NONE LEFT THIS SHIFT';
    case 'BREAK_TOO_EARLY':      return at ? `AVAILABLE AT ${at}`  : 'NOT AVAILABLE YET';
    case 'BREAK_TOO_SOON':       return at ? `NEXT BREAK AT ${at}` : 'NOT AVAILABLE YET';
    // can_start:false with a reason this build doesn't know. Say the true
    // thing — unavailable — rather than guessing at a cause.
    default:                     return at ? `AVAILABLE AT ${at}`  : 'NOT AVAILABLE YET';
  }
}

