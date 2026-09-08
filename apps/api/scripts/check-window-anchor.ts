#!/usr/bin/env ts-node
/**
 * Fail the build when the ping-window ANCHOR drifts between its two homes.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * The rule "windows are fixed-length slots anchored at scheduled_start" is
 * written twice:
 *
 *   TypeScript  services/pingWindows.ts   completedTrackableWindows's loop
 *   SQL         services/shiftHours.ts    VIOLATION_HOURS_ROW_SQL's
 *                                         generate_series grid
 *
 * Sharing a constant shares the CONSTANT. It does not share the EXPRESSION,
 * and a SQL fragment cannot call a TS function, so the two can still drift on
 * the anchor, on the FLOOR direction, or on the half-open boundary
 * convention. A comment on each pointing at the other is what this codebase
 * has already watched fail — see the header of
 * apps/mobile/constants/breakDurations.ts, where exactly that arrangement
 * did not prevent the drift it was written to prevent.
 *
 * ── AND THE LENGTH IS NO LONGER CONSTANT ────────────────────────────────
 *
 * pingWindows.ts now takes an optional intervalMs and every caller passes the
 * session's schema_v68 snapshot, so agreement has to hold at EVERY cadence
 * the picker offers — not only at the one value production happens to use.
 * Each case below therefore runs at 15/30/45/60/75/90 minutes: 6 cases x 6
 * cadences = 36 comparisons. The 30-minute rows double as the regression
 * guard that threading the parameter did not move the existing grid.
 *
 * So: enumerate the windows both ways for the same inputs and assert the
 * boundary lists are identical. Any change to either anchor that is not
 * mirrored in the other fails here.
 *
 * ── HOW IT IS WIRED ─────────────────────────────────────────────────────
 *
 * `npm run check:window-anchor` in apps/api, and — since this comment was
 * written — .github/workflows/window-anchor.yml, which runs it against a
 * throwaway postgres service container on every push and PR.
 *
 * This block previously claimed the script also ran as `pretest`. It never
 * did: apps/api has no `pretest` script and no `test` script for one to
 * hook, so there was nothing to hang it off. Removed rather than added,
 * because the workflow is the real gate.
 *
 * It needs a database because the SQL half must be EXECUTED by Postgres
 * rather than modelled — modelling it in TS would just be a third copy of
 * the same expression and would prove nothing. It does NOT need a schema:
 * the query below is a generate_series over bind parameters and touches no
 * table, so an empty database satisfies it completely. That is why CI can
 * use a bare container and no secret.
 *
 * ── REQUIRE_DB — THE DIFFERENCE BETWEEN A GATE AND A DECORATION ──────────
 *
 * With no database this exits 0 and prints SKIPPED, so a bare checkout
 * does not fail. That leniency is right locally and CATASTROPHIC in CI: a
 * required check that skips is green forever and verifies nothing, which is
 * the exact failure this repo has already shipped once (the railway-logs
 * collector exited 0 while printing its own error, and was logged as a
 * success — docs/OPS/STATE.md, "Two bugs, not one").
 *
 * So CI sets REQUIRE_DB=1, which turns the skip into a hard failure with
 * the reason printed. Local runs leave it unset and keep the old
 * behaviour. State which mode you are in before trusting a green run — and
 * if you are wiring this anywhere new, set REQUIRE_DB=1 or do not bother.
 */
import { Pool } from 'pg';
import { completedTrackableWindows } from '../src/services/pingWindows';

const CASES: Array<{ name: string; start: string; end: string }> = [
  { name: 'ordinary 8h on the half hour', start: '2026-08-01T14:00:00Z', end: '2026-08-01T22:00:00Z' },
  { name: 'off-grid start (:07)',          start: '2026-08-01T14:07:00Z', end: '2026-08-01T22:07:00Z' },
  { name: '12h overnight',                 start: '2026-08-01T22:00:00Z', end: '2026-08-02T10:00:00Z' },
  { name: 'partial tail window (7h45)',    start: '2026-08-01T14:00:00Z', end: '2026-08-01T21:45:00Z' },
  { name: 'short 45m',                     start: '2026-08-01T14:00:00Z', end: '2026-08-01T14:45:00Z' },
  { name: 'DST fall-back night',           start: '2026-11-01T00:00:00Z', end: '2026-11-01T12:00:00Z' },
];

/**
 * Every cadence the per-site picker will offer, in minutes.
 *
 * The grid is no longer a constant: services/pingWindows.ts takes an optional
 * intervalMs and every caller passes the session's schema_v68 snapshot. So the
 * TS-vs-SQL agreement has to hold at each cadence, not just at 30 — otherwise
 * this gate would keep passing while the two implementations drift apart
 * everywhere except the one value it happens to test.
 *
 * 30 stays in the list and is load-bearing twice over: it is the only cadence
 * in production today, so those six comparisons are also the regression guard
 * proving this refactor did not move the existing grid.
 *
 * sites.ping_interval_minutes permits 5..240 (schema_v14.sql:39), which is
 * wider than this list. These are the picker's values; widen the list if the
 * picker widens.
 */
const INTERVALS_MIN = [15, 30, 45, 60, 75, 90];

/** CI sets this. See the REQUIRE_DB block in the header: without it, a
 *  required check that cannot reach a database reports success. */
const REQUIRE_DB = process.env.REQUIRE_DB === '1' || process.argv.includes('--require-db');

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    if (REQUIRE_DB) {
      console.error(
        '[check-window-anchor] FAIL — REQUIRE_DB is set but no connection string is present.\n' +
        'The SQL half of this check cannot be executed, so the anchors were NOT compared.\n' +
        'This is a hard failure on purpose: skipping here would make the check green\n' +
        'while verifying nothing. Provide a database, or unset REQUIRE_DB to allow the\n' +
        'bare-checkout skip.',
      );
      return 1;
    }
    console.warn('[check-window-anchor] SKIPPED: no connection string — the SQL half cannot be executed.');
    return 0;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let failures = 0;
  try {
    for (const c of CASES) {
    for (const intervalMin of INTERVALS_MIN) {
      const intervalMs = intervalMin * 60_000;
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
      const ts = completedTrackableWindows(start, end, start, FAR, intervalMs)
        .map((w) => w.windowStart.getTime());

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
        [start.toISOString(), end.toISOString(), intervalMs],
      );
      const sql = rows.map((r) => new Date(r.ws).getTime());

      const same = ts.length === sql.length && ts.every((v, i) => v === sql[i]);
      if (!same) {
        failures += 1;
        console.error(`\n[check-window-anchor] MISMATCH — ${c.name} @ ${intervalMin}min`);
        console.error(`  scheduled_start ${c.start}   scheduled_end ${c.end}`);
        console.error(`  TS  (pingWindows.ts)  ${ts.length} windows: ${ts.slice(0, 6).map(iso).join(', ')}${ts.length > 6 ? ' …' : ''}`);
        console.error(`  SQL (shiftHours.ts)   ${sql.length} windows: ${sql.slice(0, 6).map(iso).join(', ')}${sql.length > 6 ? ' …' : ''}`);
      } else {
        console.log(
          `[check-window-anchor] OK  ${String(intervalMin).padStart(2)}min  ` +
          `${String(ts.length).padStart(3)} windows  ${c.name}`,
        );
      }
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
