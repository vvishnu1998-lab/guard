/**
 * The ONE spelling of "expand a site's active scheduling profile into concrete
 * dated slots".
 *
 * Phase B introduced this expansion inline in routes/scheduling.ts's
 * computeCoverage. Phase D needs the same slots as a LIST rather than as
 * aggregates, and a second spelling of an `AT TIME ZONE` round-trip is exactly
 * the kind of drift that produces two answers to one question — so the CTE is
 * extracted here and both callers prepend it verbatim.
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 *
 * `$1::uuid[]` is the site-id array. The fragment defines three CTEs:
 *
 *   bounds  site_id, tz, d0            — d0 is TODAY'S SITE-LOCAL calendar date
 *   win     + win_from, win_to         — the half-open window as instants
 *   slots   site_id, slot_start,       — one row per (site, instant)
 *           slot_end, guards_needed
 *
 * A caller appends its own CTEs and a SELECT. It must not redefine these
 * three names.
 *
 * ── The site-local window ────────────────────────────────────────────────
 *
 * d0 is today's SITE-LOCAL date and the 14 days are generated in DATE space.
 * Never `timestamptz + INTERVAL '14 days'`: the session TimeZone is Etc/UTC,
 * so interval-day arithmetic on an instant lands on a different site
 * wall-clock across a DST transition.
 *
 * ── The wall-clock -> instant conversion ─────────────────────────────────
 *
 * `(date + time)::timestamp AT TIME ZONE tz` is the same round-trip
 * services/tasks.ts:73 uses for task due_at, and the same idiom
 * routes/shifts.ts binds when it INSERTs a shift from a date + a time. Slot
 * instants therefore land on exactly the values a shift created for that slot
 * would carry — which is what makes exact-instant matching valid, and what
 * makes (site_id, slot_start) a usable slot identity.
 *
 * Duration is added to the INSTANT, not the wall clock, so a 6h slot is 6 real
 * hours even across a transition.
 *
 * ⚠ TWO DST HAZARDS, MEASURED, NOT FIXED HERE. Neither fires in a window that
 * does not contain a US transition; the first to bite is the window opening
 * 2026-10-19 (fall-back 2026-11-01), then 2027-03-14.
 *   1. SPRING FORWARD: a nonexistent local time does NOT raise. Postgres maps
 *      it forward, so a 02:30 slot and a 03:30 slot on 2027-03-14 both resolve
 *      to 2027-03-14T10:30Z — one shift would satisfy both.
 *   2. FALL BACK: the ambiguous hour resolves to the LATER (standard-time)
 *      instant — 2026-11-01 01:30 -> 09:30Z, not 08:30Z. A shift genuinely
 *      created at the first 01:30 will not match its slot.
 * Both need a decision about what a slot MEANS on a transition day, which is a
 * product question, not a formatting one. Filed as N52.
 *
 * ── Grouping, and why slot_end uses MAX ──────────────────────────────────
 *
 * Slots group by (site_id, slot_start) with guards_needed SUMMED. There is no
 * unique constraint on (profile_id, day_of_week, shift_start_time), so two
 * template rows may describe the same instant; summing is the only reading
 * consistent with `required`, which sums every row.
 *
 * When such duplicates differ in LENGTH the merge has no single right answer.
 * MAX(shift_length_hours) is used: the post is occupied until the last guard
 * leaves, so the longer reading is the safe one for a coverage display. It is
 * still a merge artifact — two rows that start together but run 6h and 12h are
 * two different staffing intents, and this collapses them into one 12h slot
 * needing two guards. No such duplicate exists in production today (verified:
 * zero rows share profile_id + day_of_week + shift_start_time). A unique
 * constraint on that triple would remove the ambiguity outright and is the
 * real fix if it ever occurs.
 */

/** Window length in days. Kept here so both callers cannot drift apart. */
export const SLOT_WINDOW_DAYS = 14;

/**
 * CTE chain defining `bounds`, `win` and `slots`. Prepend after `WITH `, then
 * append `, your_cte AS (...) SELECT ...`. Binds `$1::uuid[]`.
 */
export const SLOT_EXPANSION_CTE = `
     bounds AS (
       SELECT s.id AS site_id,
              s.timezone AS tz,
              (now() AT TIME ZONE s.timezone)::date AS d0
         FROM sites s
        WHERE s.id = ANY($1::uuid[])
     ),
     win AS (
       SELECT b.*,
              (b.d0)::timestamp      AT TIME ZONE b.tz AS win_from,
              (b.d0 + ${SLOT_WINDOW_DAYS})::timestamp AT TIME ZONE b.tz AS win_to
         FROM bounds b
     ),
     slots AS (
       SELECT w.site_id,
              (((w.d0 + n)::date + ps.shift_start_time)::timestamp AT TIME ZONE w.tz) AS slot_start,
              (((w.d0 + n)::date + ps.shift_start_time)::timestamp AT TIME ZONE w.tz)
                + (MAX(ps.shift_length_hours)::double precision * INTERVAL '1 hour') AS slot_end,
              SUM(ps.guards_needed)::int AS guards_needed
         FROM win w
         CROSS JOIN generate_series(0, ${SLOT_WINDOW_DAYS - 1}) AS n
         JOIN site_scheduling_profiles p ON p.site_id = w.site_id AND p.is_active = true
         JOIN site_profile_shifts ps     ON ps.profile_id = p.id  AND ps.active = true
        WHERE EXTRACT(DOW FROM (w.d0 + n)::date)::int = ps.day_of_week
        GROUP BY w.site_id, slot_start
     )`;

/**
 * Shifts that OCCUPY a post in the window — the rows that count toward
 * `filled`. Depends on `win`. Binds nothing extra.
 *
 * `unassigned` is excluded because such a row has nobody on post; it is
 * surfaced separately so an assign action can PATCH it rather than create a
 * second row at the same instant.
 */
export const OCCUPIED_CTE = `
     occupied AS (
       SELECT sh.id, sh.site_id, sh.scheduled_start
         FROM shifts sh
         JOIN win w ON w.site_id = sh.site_id
        WHERE sh.status NOT IN ('cancelled', 'unassigned')
          AND sh.scheduled_start >= w.win_from
          AND sh.scheduled_start <  w.win_to
     )`;
