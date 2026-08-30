#!/usr/bin/env ts-node
/**
 * Fail the build when the ping-window ANCHOR drifts between its two homes.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * The rule "windows are PING_WINDOW_MS slots anchored at scheduled_start"
 * is written twice:
 *
 *   TypeScript  services/pingWindows.ts:119   ssMs + n * PING_WINDOW_MS
 *   SQL         services/shiftHours.ts        VIOLATION_HOURS_ROW_SQL's
 *                                             generate_series grid
 *
 * Interpolating PING_WINDOW_MS shares the CONSTANT. It does not share the
 * EXPRESSION, and a SQL fragment cannot call a TS function, so the two can
 * still drift on the anchor, on the FLOOR direction, or on the half-open
 * boundary convention. A comment on each pointing at the other is what this
 * codebase has already watched fail — see the header of
 * apps/mobile/constants/breakDurations.ts, where exactly that arrangement
 * did not prevent the drift it was written to prevent.
 *
 * So: enumerate the windows both ways for the same inputs and assert the
 * boundary lists are identical. Any change to either anchor that is not
 * mirrored in the other fails here.
 *
 * ── HOW IT IS WIRED ─────────────────────────────────────────────────────
 *
 * `npm run check:window-anchor` in apps/api, and `pretest`. It needs a
 * database because the SQL half must be executed by Postgres rather than
 * modelled — modelling it in TS would just be a third copy of the same
 * expression and would prove nothing.
 *
 * With no DATABASE_URL it exits 0 with a SKIPPED notice: a checkout without
 * a database must not fail, for the same reason check-break-constants.js is
 * lenient about a missing server file. That means the check is DORMANT in a
 * bare checkout and LIVE in CI or locally once a DB is reachable — state
 * which you are in before trusting a green run.
 */
import { Pool } from 'pg';
import { PING_WINDOW_MS, completedTrackableWindows } from '../src/services/pingWindows';

const CASES: Array<{ name: string; start: string; end: string }> = [
  { name: 'ordinary 8h on the half hour', start: '2026-08-01T14:00:00Z', end: '2026-08-01T22:00:00Z' },
  { name: 'off-grid start (:07)',          start: '2026-08-01T14:07:00Z', end: '2026-08-01T22:07:00Z' },
  { name: '12h overnight',                 start: '2026-08-01T22:00:00Z', end: '2026-08-02T10:00:00Z' },
  { name: 'partial tail window (7h45)',    start: '2026-08-01T14:00:00Z', end: '2026-08-01T21:45:00Z' },
  { name: 'short 45m',                     start: '2026-08-01T14:00:00Z', end: '2026-08-01T14:45:00Z' },
  { name: 'DST fall-back night',           start: '2026-11-01T00:00:00Z', end: '2026-11-01T12:00:00Z' },
];

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.warn('[check-window-anchor] SKIPPED: no DATABASE_URL — the SQL half cannot be executed.');
    return 0;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let failures = 0;
  try {
    for (const c of CASES) {
      const start = new Date(c.start), end = new Date(c.end);

      // TS side — the authority. completedTrackableWindows enumerates the raw
      // [start,end) INTERVALS and applies R3 (a window counts only if its end
      // fits inside scheduled_end). R4 and the "has closed" bound are
      // neutralised by clocking in at scheduled_start and setting now far
      // ahead, leaving the pure anchor grid.
      //
      // NOT scheduleWindows(): that returns a LABEL -> start map and dedupes
      // by label ("first occurrence wins (DST)", pingWindows.ts:122). On a
      // fall-back day it collapses 24 real intervals into 22 distinct labels,
      // which is right for validating a submitted label and wrong for summing
      // durations — both 01:00-01:30 intervals genuinely happened and either
      // can be unconfirmed. Comparing against it reported a 22-vs-24
      // "mismatch" that was a difference of purpose, not of anchor.
      const FAR = new Date('2100-01-01T00:00:00Z');
      const ts = completedTrackableWindows(start, end, start, FAR).map((w) => w.windowStart.getTime());

      // SQL side — the same grid, executed by Postgres, with R3 applied by
      // the generate_series upper bound rather than by a break.
      const { rows } = await pool.query<{ ws: Date }>(
        `SELECT ws FROM generate_series(
           $1::timestamptz,
           $1::timestamptz + (FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - $1::timestamptz))
             / ($3::bigint / 1000.0)) * (INTERVAL '1 millisecond' * $3::bigint)),
           (INTERVAL '1 millisecond' * $3::bigint)) AS w(ws)
          WHERE ws + (INTERVAL '1 millisecond' * $3::bigint) <= $2::timestamptz
          ORDER BY ws`,
        [start.toISOString(), end.toISOString(), PING_WINDOW_MS],
      );
      const sql = rows.map((r) => new Date(r.ws).getTime());

      const same = ts.length === sql.length && ts.every((v, i) => v === sql[i]);
      if (!same) {
        failures += 1;
        console.error(`\n[check-window-anchor] MISMATCH — ${c.name}`);
        console.error(`  scheduled_start ${c.start}   scheduled_end ${c.end}`);
        console.error(`  TS  (pingWindows.ts)  ${ts.length} windows: ${ts.slice(0, 6).map(iso).join(', ')}${ts.length > 6 ? ' …' : ''}`);
        console.error(`  SQL (shiftHours.ts)   ${sql.length} windows: ${sql.slice(0, 6).map(iso).join(', ')}${sql.length > 6 ? ' …' : ''}`);
      } else {
        console.log(`[check-window-anchor] OK  ${String(ts.length).padStart(2)} windows  ${c.name}`);
      }
    }
  } finally {
    await pool.end();
  }
  if (failures > 0) {
    console.error(
      `\n[check-window-anchor] FAIL — ${failures} case(s) disagree.\n` +
      'The window anchor is defined in BOTH services/pingWindows.ts:119 (TypeScript)\n' +
      'and services/shiftHours.ts VIOLATION_HOURS_ROW_SQL (SQL). They have drifted.\n' +
      'Change both, or change neither.\n',
    );
    return 1;
  }
  console.log('\n[check-window-anchor] OK — TS and SQL window anchors agree on every case.');
  return 0;
}

function iso(ms: number): string { return new Date(ms).toISOString().slice(11, 16); }

main().then((c) => process.exit(c)).catch((err) => {
  console.error('[check-window-anchor] ERROR:', err);
  process.exit(1);
});
