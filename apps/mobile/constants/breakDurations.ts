/**
 * Break policy — mobile copy.
 *
 * ── HOW DRIFT IS PREVENTED (2026-08-29) ─────────────────────────────────
 *
 * The previous version of this file opened with "KEEP IN SYNC with
 * apps/api/src/constants/breakDurations.ts … Any duration change MUST land
 * on both sides in the same batch." That is exactly what failed: a comment
 * asking a human to remember is not a mechanism. Two things replace it.
 *
 * 1. MECHANICAL CHECK. scripts/check-break-constants.js parses BOTH this
 *    file and the server's and fails if the numbers disagree. It is wired
 *    to `postinstall` in apps/mobile/package.json, so it runs on every
 *    `npm install` and — the part that matters — inside every EAS build,
 *    which installs before it bundles. A drifted constant fails the build
 *    instead of shipping.
 *
 * 2. SHRUNK SURFACE. This file used to carry three durations and, by way of
 *    the screen's BREAK_OPTIONS, three quotas. It now carries ONE number,
 *    and that number is DISPLAY-ONLY:
 *
 *      * the planned duration actually used is whatever the server returns
 *        as planned_duration_minutes on POST /shifts/break-start, and the
 *        timer counts from that, not from this constant;
 *      * the allowance is computed server-side from scheduled shift length
 *        and arrives on GET /shifts/active-session — mobile never derives it.
 *
 *    So the worst a drifted value can now do is render "25 MINUTES" on a
 *    card whose timer then runs 30. It cannot change an allowance, a gate,
 *    or a stored row. Behaviour is server-authoritative by construction.
 *
 * ── ONE BREAK TYPE (design locked 2026-08-29) ───────────────────────────
 *
 * Was meal 30 / rest 15 / other 10 with a per-type quota. Now one type,
 * label "break", 30 minutes, PAID. Allowance comes from scheduled shift
 * length (<= 8h -> 1, > 8h -> 2), not from the type.
 */

/** The only break type. Mirrors the server's BreakType. */
export type BreakType = 'break';

export const BREAK_TYPE: BreakType = 'break';

/**
 * DISPLAY ONLY — see the header. The authoritative value is
 * planned_duration_minutes on the break-start response.
 * Checked against the server constant by scripts/check-break-constants.js.
 */
export const BREAK_DURATION_MINUTES = 30;
