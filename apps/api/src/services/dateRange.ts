/**
 * Whole-day date-range predicates, anchored in the SITE's timezone.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Two routes filtering geofence_violations carried the same two lines:
 *
 *     AND gv.occurred_at >= $n
 *     AND gv.occurred_at <= $n
 *
 * Both were wrong the same way, twice over. The bound was INCLUSIVE against
 * a bare date, so `date_to=2026-08-19` compared against 2026-08-19T00:00:00
 * and discarded the whole of the 19th; and the param was UNCAST, so the
 * implicit text -> timestamptz coercion resolved at the session timezone
 * (UTC on Railway) rather than at the site. Filtering an admin's Live Status
 * breaches to 17->19 Aug returned ONE of the four violations in that window;
 * the billing workbook, anchored per-site since P4, showed all four.
 *
 * The same expression had already been fixed once in routes/exports.ts and
 * once in routes/billing.ts. Copy-per-caller is what produced the 405 h
 * off-post defect and the eight divergent copies of the hours arithmetic, so
 * this is a builder rather than a third and fourth hand-written pair.
 *
 * ── PER-ROW SITE TIMEZONE ────────────────────────────────────────────────
 *
 * `AT TIME ZONE ${siteAlias}.timezone` is evaluated PER ROW against the
 * joined sites row, so each record is judged inside its own site's calendar
 * day. A result set spanning sites in different zones stays correct without
 * anyone choosing a winner. The alternative — one company-default zone —
 * misfiles every row for a tenant spanning zones and buys nothing. Every
 * production site is America/Los_Angeles today, so the two are currently
 * indistinguishable, which is precisely why the correct one is free to adopt.
 *
 * ── BARE DATE vs INSTANT ─────────────────────────────────────────────────
 *
 * Both routes validate their params with an ISO_RE that also admits a full
 * instant, and Live Status genuinely sends one: when no explicit range is
 * set, its CSV button materialises the chip window as
 * `new Date(ms).toISOString()`. The same parameter therefore carries two
 * different intents, and blindly wrapping ::date would silently floor that
 * instant to midnight.
 *
 * So the shape of the value decides the semantics:
 *
 *   'YYYY-MM-DD'        whole-day, site-local:
 *                         from  >= (date)::timestamp        AT TIME ZONE tz
 *                         to    <  (date + 1 day)           AT TIME ZONE tz
 *   anything with 'T'   exact instant, as given:
 *                         from  >= $n::timestamptz
 *                         to    <  $n::timestamptz
 *
 * Both upper bounds are EXCLUSIVE. For the whole-day form that is the fix.
 * For the instant form it is a deliberate change from the old `<=`: a
 * half-open interval is the only one that tiles without overlap, and an
 * exact-instant upper bound is a cut, not a member. No caller in the tree
 * sends an instant as `date_to` today — Live Status sends one only as
 * `date_from` — so nothing observable changes for the instant path.
 */

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SiteLocalRangeInput {
  /** Fully-qualified timestamptz column, e.g. 'gv.occurred_at'. */
  column:    string;
  /** Alias of the joined sites row carrying `.timezone`, e.g. 's'. */
  siteAlias: string;
  from?:     string | null;
  to?:       string | null;
  /**
   * The query's parameter array. Values are PUSHED onto it, and the emitted
   * clauses reference them by the resulting 1-based position — so call this
   * at the point in the builder sequence where the params belong.
   */
  args:      unknown[];
}

/**
 * Returns the range clauses, each already prefixed with `AND `. Empty when
 * neither bound is supplied, so callers can fall back to their own default
 * window.
 */
export function siteLocalDayRange(input: SiteLocalRangeInput): string[] {
  const { column, siteAlias, from, to, args } = input;
  const tz = `${siteAlias}.timezone`;
  const out: string[] = [];

  if (from) {
    args.push(from);
    const p = `$${args.length}`;
    out.push(BARE_DATE.test(from)
      ? `AND ${column} >= ((${p}::date)::timestamp AT TIME ZONE ${tz})`
      : `AND ${column} >= ${p}::timestamptz`);
  }
  if (to) {
    args.push(to);
    const p = `$${args.length}`;
    out.push(BARE_DATE.test(to)
      ? `AND ${column} <  ((${p}::date + INTERVAL '1 day') AT TIME ZONE ${tz})`
      : `AND ${column} <  ${p}::timestamptz`);
  }
  return out;
}
