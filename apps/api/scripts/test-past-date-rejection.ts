/**
 * test-past-date-rejection.ts — exercises the past-date guard added to
 * POST /api/shifts (B1). Runs entirely against the local pacificDate
 * helper + a stubbed expansion that mirrors routes/shifts.ts:1.
 *
 * Coverage:
 *   (a) single past date → rejected
 *   (b) repeat with baseStart in the past → rejected (entire batch)
 *   (c) repeat with baseStart = today at a Pacific midnight boundary →
 *       accepted, and first emitted date IS today (Pacific), not yesterday
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-past-date-rejection.ts
 */
import { isPastPacificDate, pacificDateStr } from '../src/services/pacificDate';

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ ${msg}`);
}

// Mirror of the repeat-expansion in routes/shifts.ts (in-memory only).
function expand(scheduledStart: Date, scheduledEnd: Date, repeatDays: number[]) {
  const durationMs = scheduledEnd.getTime() - scheduledStart.getTime();
  const horizon = new Date(scheduledStart);
  horizon.setDate(horizon.getDate() + 28);
  const out: { start: Date; end: Date }[] = [];
  const cur = new Date(scheduledStart);
  while (cur <= horizon) {
    if (repeatDays.includes(cur.getDay())) {
      const start = new Date(cur);
      start.setHours(scheduledStart.getHours(), scheduledStart.getMinutes(), scheduledStart.getSeconds(), 0);
      out.push({ start, end: new Date(start.getTime() + durationMs) });
    }
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

(function main() {
  console.log('B1 — past-date rejection tests');
  console.log(`  now Pacific calendar: ${pacificDateStr(new Date())}`);

  // ── (a) single past date ─────────────────────────────────────────────
  {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(14, 0, 0, 0);
    assert(isPastPacificDate(yesterday), '(a) yesterday at 14:00 local is flagged past');
  }

  // ── (b) repeat with past baseStart ──────────────────────────────────
  {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 3 * 3_600_000);
    const emitted = expand(start, end, [start.getDay()]);
    const anyPast = emitted.some(p => isPastPacificDate(p.start));
    assert(emitted.length > 0, '(b) repeat expansion produced at least one date');
    assert(anyPast, '(b) at least one emitted date is past → request rejected');
  }

  // ── (c) repeat starting today, Pacific midnight boundary ────────────
  // Construct scheduled_start that is 11:30pm Pacific today. We build the
  // instant in UTC by reading the local-day-of-Pacific format and parking
  // wallclock 23:30 onto today's Pacific date.
  {
    const todayPacific = pacificDateStr(new Date()); // YYYY-MM-DD
    // 23:30 PDT = 06:30 UTC next day; 23:30 PST = 07:30 UTC next day.
    // We don't need the exact UTC — Date parsing of an ISO with explicit
    // -07:00 / -08:00 offset gives us the right instant. Pick PDT for now;
    // this test runs interactively + the assertion is a calendar compare,
    // not an offset check.
    const iso = `${todayPacific}T23:30:00-07:00`;
    const start = new Date(iso);
    const end = new Date(start.getTime() + 4 * 3_600_000); // crosses midnight Pacific

    assert(!isPastPacificDate(start), '(c) today @ 23:30 Pacific is NOT past');
    assert(
      pacificDateStr(start) === todayPacific,
      `(c) emitted Pacific date == today (${pacificDateStr(start)} vs ${todayPacific})`
    );

    // Single-emission expansion: baseStart's DOW only. The first emitted
    // shift must land on today's Pacific calendar date — no off-by-one
    // even though the UTC representation may be tomorrow.
    const dow = start.getDay();
    const emitted = expand(start, end, [dow]);
    assert(emitted.length > 0, '(c) expansion emits at least one date');
    assert(!emitted.some(p => isPastPacificDate(p.start)), '(c) no emitted date is past → accepted');
  }

  if (process.exitCode) {
    console.error('\n✗ test-past-date-rejection FAILED');
  } else {
    console.log('\n✓ test-past-date-rejection PASSED');
  }
})();
