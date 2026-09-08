/**
 * Lateness display for the admin live-status surfaces.
 *
 * TWO functions, two different questions. Pick by what the timestamp is
 * accountable to, not by which is nearer to hand:
 *
 *   computeLatenessAnchored — for PINGS. Ping windows are anchored to the
 *     SHIFT's scheduled_start, so the grid is per-shift and is NOT knowable
 *     from the wall clock.
 *   computeLateness — for hourly ACTIVITY REPORTS. Those genuinely do run on
 *     a wall-clock top-of-hour cadence (apps/api/src/jobs/pingReminder.ts's
 *     R5 leg fires at UTC minute 0), so `[0]` is the right grid there.
 *
 * ── THE ":00 / :30 PAST THE HOUR" PREMISE WAS WRONG FOR PINGS ────────────
 *
 * This module used to assert that "our schedules are :00 / :30 past the
 * hour" and graded pings on it. Ping windows are scheduled_start + N*30min
 * (apps/api/src/services/pingWindows.ts), which coincides with :00/:30 only
 * when scheduled_start happens to. 466 of 492 production shifts do; 26 do
 * not, and the premise is silent — it yields a plausible number, never an
 * error.
 *
 * Measured on session 9021350a (375 Shopping Complex, scheduled_start 14:48
 * site-local, 2026-09-07) the old form was wrong in BOTH directions:
 *   * an ON-TIME 15:18 ping rendered "+18m late";
 *   * a genuinely 16-min-late 18:04 ping rendered "+4m late".
 * The second is the one that matters. The column did not merely exaggerate,
 * so it could not be read as a safe over-estimate — it made a late guard
 * look punctual.
 *
 * The same defect was already found and fixed once, in the activity log
 * (components/ActivityLogTable.tsx): there the fix was to render the
 * SERVER's window-attributed grading instead of recomputing client-side.
 * This surface has no server-side grading to defer to, so it anchors on
 * scheduled_start — which GET /api/admin/live-guards has carried since
 * commit 9c98957 (apps/api/src/routes/admin.ts:934).
 *
 * Timezone: window boundaries are pure epoch arithmetic and carry no
 * timezone — the same property apps/mobile/lib/pingSchedule.ts:39-41 relies
 * on. Only the DISPLAY is zoned, and it is formatted in Pacific. DST is
 * handled by Intl.DateTimeFormat; the underlying instant doesn't change.
 *
 * Lives in its own module (rather than inline in
 * apps/web/app/admin/live-status/page.tsx) so it's importable from
 * tests and other pages. Next.js page files reject custom named
 * exports.
 */

/**
 * Wall-clock lateness against boundaries `scheduleMinutes` past the hour.
 * Whole-minute floor. On-boundary reads "(on time)". Null actual → "—".
 *
 * DO NOT pass `[0, 30]` for pings. That was this function's original ping
 * usage and it is exactly the bug computeLatenessAnchored below replaces.
 * Its only correct callers are the two hourly-report columns — the LAST RPT
 * field in components/admin/LiveMap.tsx and the `report` binding in
 * app/admin/live-status/page.tsx. Cited by symbol rather than line: both
 * moved within this very commit, and a line number that is already stale
 * when it is written is worse than none.
 */
export function computeLateness(
  actualISO: string | null,
  scheduleMinutes: number[],
): { display: string } {
  if (!actualISO) return { display: '—' };
  const actual        = new Date(actualISO);
  const actualMs      = actual.getTime();
  const hourStartMs   = Math.floor(actualMs / 3_600_000) * 3_600_000;
  const candidates: number[] = [];
  for (const m of scheduleMinutes) {
    candidates.push(hourStartMs + m * 60_000);
    candidates.push(hourStartMs - 3_600_000 + m * 60_000);
  }
  const boundaryMs = Math.max(...candidates.filter((b) => b <= actualMs));
  const lateMins   = Math.floor((actualMs - boundaryMs) / 60_000);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  }).format(actual);
  return { display: lateMins === 0 ? `${time} (on time)` : `${time} (+${lateMins}m late)` };
}

/**
 * The ping cadence this surface grades against, in ms.
 *
 * LIMIT (a) — 30 min is a DEFAULT PARAMETER, not a platform constant.
 * sites.ping_interval_minutes already exists (INTEGER NOT NULL DEFAULT 30,
 * CHECK 5..240, apps/api/src/db/schema_v14.sql:38) and every one of the 23
 * production sites reads 30 today, but NOTHING on the server reads that
 * column yet. Wiring a per-site interval end to end is a later phase; this
 * parameter is the seam it will widen. Do not read the presence of this
 * default as a claim that the cadence is uniform by design.
 */
const DEFAULT_PING_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Pacific HH:MM for an instant.
 *
 * Deliberately a second copy of the formatter inside computeLateness above,
 * which this dispatch froze so the hourly-report columns could not regress.
 * The option bags are identical and must stay so; collapsing them onto one
 * helper is a follow-up, not a thing to do inside a frozen function.
 */
function fmtPacificHHMM(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  }).format(new Date(ms));
}

/**
 * Ping lateness measured against the SHIFT's own window grid:
 * scheduled_start + N * intervalMs. Returns "HH:MM (on time)" or
 * "HH:MM (+Nm late)"; null/unparseable actual → "—".
 *
 * LIMIT (a): see DEFAULT_PING_INTERVAL_MS — the 30 minutes is a default
 * parameter, and per-site cadence is a later phase.
 *
 * LIMIT (b) — THIS MEASURES DEPTH INTO THE CURRENT WINDOW, NOT ELAPSED
 * OBLIGATION. The input is last_ping_at: the LAST ping only. A guard who
 * skips a window entirely and then pings two minutes into the next one
 * renders "(+2m late)", not "one window missed" — the skipped window is
 * invisible here because no timestamp records it. That is not a bug to fix
 * in this function; a gap is the absence of a row, and the authoritative
 * record of it is the missed_pings table
 * (apps/api/src/jobs/missedPingCron.ts). Read this column as "how deep into
 * the current window was the last check-in", never as "how compliant is
 * this guard".
 *
 * Unknown anchor, or a ping that PRECEDES scheduled_start, renders the bare
 * time with no lateness clause. An older API omits scheduled_start (the
 * stale-API rule: Vercel and Railway are never simultaneous), and a ping
 * before the shift starts belongs to no window the guard owes — R4 in
 * apps/api/src/services/pingWindows.ts:178. In both cases we can state WHEN
 * and not HOW LATE, and emitting a number anyway is precisely what the
 * wall-clock form got wrong.
 */
export function computeLatenessAnchored(
  actualISO:         string | null,
  scheduledStartISO: string | null | undefined,
  intervalMs:        number = DEFAULT_PING_INTERVAL_MS,
): { display: string } {
  if (!actualISO) return { display: '—' };
  const actualMs = Date.parse(actualISO);
  if (!Number.isFinite(actualMs)) return { display: '—' };
  const time = fmtPacificHHMM(actualMs);

  const startMs = scheduledStartISO ? Date.parse(scheduledStartISO) : NaN;
  if (!Number.isFinite(startMs) || actualMs < startMs) return { display: time };
  // Guard a non-positive interval: %0 is NaN and would render "+NaNm late".
  if (!(intervalMs > 0)) return { display: time };

  const lateMins = Math.floor(((actualMs - startMs) % intervalMs) / 60_000);
  return { display: lateMins === 0 ? `${time} (on time)` : `${time} (+${lateMins}m late)` };
}

/**
 * Minutes after which a guard's last ping reads as stale. Wall-clock, and
 * deliberately independent of computeLateness above: that one measures the
 * ping against its SCHEDULE boundary for display, this one measures it
 * against NOW for urgency. A guard who pinged perfectly on time an hour ago
 * is "(on time)" and stale at once, and both statements are correct.
 */
export const PING_STALE_MINUTES = 35;

/**
 * The stale-ping urgency rule, lifted verbatim out of
 * app/admin/live-status/page.tsx so the table cell and the map pin cannot
 * drift apart. Behaviour is unchanged from the inline form it replaces —
 * the added Number.isFinite guard only makes explicit what an unparseable
 * date already did (NaN >= 35 is false).
 */
export function isPingStale(
  lastPingISO: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!lastPingISO) return false;
  const t = Date.parse(lastPingISO);
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) / 60_000 >= PING_STALE_MINUTES;
}
