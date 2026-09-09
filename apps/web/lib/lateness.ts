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
  // Was an inline Intl.DateTimeFormat with an option bag byte-identical to
  // fmtPacificHHMM's. Collapsed here; `actual` and `new Date(actualMs)` are
  // value-equal, and both forms throw the same RangeError on an unparseable
  // input, so this is behaviour-preserving including the failure path.
  const time = fmtPacificHHMM(actualMs);
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
 * Slack allowed on top of one window before a ping reads as stale.
 *
 * GRACE MODELS SUBMISSION LATENCY, NOT A FRACTION OF THE WINDOW. A guard
 * receives the push, opens the app, captures a photo and uploads it. That is
 * a fixed cost in the handset and the network; it does not get cheaper
 * because the window is shorter. So the grace is an absolute 5 minutes, not
 * a percentage — which is why the formula below adds rather than scales.
 */
export const GRACE_MINUTES = 5;

/**
 * Minutes without a ping after which the guard reads as stale, for a session
 * on `intervalMinutes` cadence: one full window, plus grace.
 *
 * The min() clamp keeps grace from exceeding a third of the window. It
 * computes EXACTLY 5 at 15, 30 and 45 — the entire picker set (D15) — so
 * every threshold in production is unchanged by this function's arrival:
 *
 *     15 -> 20     30 -> 35 (today's value)     45 -> 50
 *
 * The clamp only bites below 15 (at 5 it gives 5 + 1.67 = 6.67), which the
 * picker cannot reach and only direct SQL can. It exists so an out-of-band
 * value degrades to something proportionate instead of a grace longer than
 * the window it follows.
 */
export function pingStaleMinutes(intervalMinutes: number): number {
  if (!(intervalMinutes > 0)) return 30 + GRACE_MINUTES;
  return intervalMinutes + Math.min(GRACE_MINUTES, intervalMinutes / 3);
}

/**
 * @deprecated Use pingStaleMinutes(interval) — this constant assumes a
 * 30-minute cadence. Kept exported so nothing breaks in the commit that
 * introduces the per-session form; it is exactly pingStaleMinutes(30).
 */
export const PING_STALE_MINUTES = 35;

/**
 * The stale-ping urgency rule — shared so the table cell, the map pin and
 * the client portal cannot drift apart. (The client portal previously had
 * its own hardcoded 35, importing nothing from here.)
 *
 * Deliberately independent of computeLatenessAnchored: that one measures the
 * ping against ITS OWN WINDOW, this one measures it against NOW. A guard who
 * pinged perfectly on time 48 minutes ago is both "(on time)" and stale, and
 * both statements are true — see pingCellDisplay for why they must not be
 * rendered in the same breath.
 *
 * `intervalMs` is a trailing default parameter, the same seam shape
 * computeLatenessAnchored uses: an API that predates the field yields
 * undefined, the caller COALESCEs to 30, and the threshold is today's 35.
 */
export function isPingStale(
  lastPingISO: string | null | undefined,
  nowMs: number = Date.now(),
  intervalMs: number = DEFAULT_PING_INTERVAL_MS,
): boolean {
  if (!lastPingISO) return false;
  const t = Date.parse(lastPingISO);
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) / 60_000 >= pingStaleMinutes(intervalMs / 60_000);
}

/**
 * The LAST PING cell's text — ONE cell, ONE assertion.
 *
 * ── THE BUG THIS FIXES, SEEN LIVE ───────────────────────────────────────
 *
 * The cell used to render computeLatenessAnchored's output and colour it red
 * with a pulsing "!" when isPingStale said so. On 2026-09-08 a real row read
 *
 *     16:00 (on time)  !          (red)
 *
 * for GRD0012 — scheduled_start 21:00:00Z, ping 23:00:26Z, genuinely 26
 * seconds into its window and genuinely 48 minutes ago. BOTH HALVES WERE
 * CORRECT. The text answered "was this ping late for its window"; the red
 * and the "!" answered "how long since any ping". One cell asserting two
 * different things reads to an admin as a contradiction, and the resolution
 * is not to fix either half — it is to stop asking one cell both questions.
 *
 * So: while the ping is FRESH the useful fact is where it sat in its window;
 * once it is STALE the useful fact is how long it has been. The red already
 * means "stale", and now the text agrees with it instead of arguing.
 *
 * This DOES change rendered copy for every stale row, not only the "(on
 * time)" ones — that is intended. A stale row's window position is history;
 * the actionable number is the elapsed time. The map popup still shows both
 * facts, in separate fields, where they do not collide.
 */
export function pingCellDisplay(
  lastPingISO:       string | null | undefined,
  scheduledStartISO: string | null | undefined,
  nowMs:             number = Date.now(),
  intervalMs:        number = DEFAULT_PING_INTERVAL_MS,
): { display: string; stale: boolean } {
  const stale = isPingStale(lastPingISO, nowMs, intervalMs);
  if (!lastPingISO) return { display: '—', stale };
  const t = Date.parse(lastPingISO);
  if (!Number.isFinite(t)) return { display: '—', stale };
  if (!stale) {
    return { display: computeLatenessAnchored(lastPingISO, scheduledStartISO, intervalMs).display, stale };
  }
  const mins = Math.floor((nowMs - t) / 60_000);
  const elapsed = mins < 60
    ? `${mins}m ago`
    : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m ago`;
  return { display: `${fmtPacificHHMM(t)} · ${elapsed}`, stale };
}
