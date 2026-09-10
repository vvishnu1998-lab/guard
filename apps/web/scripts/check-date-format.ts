#!/usr/bin/env ts-node
/**
 * Enforce, by running it, that the calendar-date formatters in
 * lib/shiftFormat.ts never move the day.
 *
 * WHY THIS EXISTS (N55). The admin app printed bare calendar dates as ISO
 * (2026-09-10) one click away from an <input type="date"> rendering the same
 * day in browser locale (09/10/2026). Those denote different days, so the fix
 * was to give every DISPLAYED date a month name.
 *
 * The obvious way to do that is the one that breaks it:
 *
 *     new Date('2026-09-10')                        -> 2026-09-10T00:00:00Z
 *     ...toLocaleDateString in America/Los_Angeles  -> "09 Sept 2026"   WRONG
 *
 * A bare date string parses as UTC MIDNIGHT, so every zone west of UTC
 * renders the day before. The inverse mistake - build local midnight, then
 * round-trip through toISOString().slice(0,10) - fails in the other
 * direction, for every zone east of UTC. THAT IS WHY THIS RUNS ON BOTH SIDES:
 * one zone alone cannot catch both.
 *
 * These are not cosmetic values. guard_site_assignments.assigned_from /
 * assigned_until are DATE columns and are the same values
 * services/guardAssignments.ts:checkShiftEligibility compares server-side.
 * Shifting them by a day in the UI would be a semantics change wearing a
 * formatting change's clothes.
 *
 * A comment saying "do not construct a Date here" is not enforcement. This
 * is. If anyone reimplements fmtCalDate as new Date(ymd), the west-of-UTC
 * runs fail.
 *
 * Run: npm run check:date-format   (from apps/web). Not postinstall - it
 * spawns child processes and needs ts-node, neither of which belongs in an
 * install hook.
 */
import { spawnSync } from 'child_process';
import {
  fmtCalDate, fmtCalRange, fmtDate, fmtDateShort, fmtDT, fmtTime,
  fmtDuration, dayOffsetInZone, isoToZonedInputs, zonedInputsToISO,
} from '../lib/shiftFormat';

/** Zones spanning both sides of UTC, including a half-hour offset and the two
 *  extremes. Kiritimati is UTC+14, Midway UTC-11. */
const ZONES = [
  'Pacific/Kiritimati',   // UTC+14  - catches the local-midnight round-trip
  'Asia/Kolkata',         // UTC+5:30 - half-hour offset
  'Etc/UTC',              // UTC
  'America/Los_Angeles',  // UTC-7/-8 - catches new Date(ymd), and is prod
  'Pacific/Midway',       // UTC-11  - furthest west
];

/** Bare calendar dates: every month (Sept is the one where en-GB and en-US
 *  disagree), both year boundaries, a leap day, and both US DST transitions. */
const CAL_DATES = [
  '2026-01-01', '2026-02-14', '2026-03-08', '2026-04-30',
  '2026-05-31', '2026-06-01', '2026-07-04', '2026-08-10',
  '2026-09-10', '2026-10-09', '2026-11-01', '2026-12-31',
  '2024-02-29',              // leap day
  '2026-03-08', '2026-11-01', // US DST spring-forward / fall-back
  '2025-12-31', '2026-01-01', // year boundary either side
];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];

let failures = 0;
function fail(msg: string): void { failures++; console.error(`  FAIL  ${msg}`); }

function checkInThisZone(zone: string): void {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`\n--- ${zone}  (process resolved: ${resolved}) ---`);

  // 1. fmtCalDate: the rendered day/month/year must EQUAL the input's, with
  //    no Date anywhere in the path. This is the assertion that fails if
  //    anyone reintroduces new Date(ymd).
  for (const ymd of CAL_DATES) {
    const [y, m, d] = ymd.split('-');
    const expected = `${d} ${MONTHS[Number(m) - 1]} ${y}`;
    const got = fmtCalDate(ymd);
    if (got !== expected) fail(`fmtCalDate('${ymd}') -> '${got}', expected '${expected}'`);
  }

  // 2. fmtCalRange: both endpoints must survive, and the collapse rules hold.
  const rangeCases: [string, string, string][] = [
    ['2026-09-10', '2026-10-09', '10 Sept - 9 Oct 2026'.replace('9 Oct', '09 Oct')],
    ['2026-09-10', '2026-09-24', '10 - 24 Sept 2026'],
    ['2025-12-31', '2026-01-01', '31 Dec 2025 - 01 Jan 2026'],
  ];
  for (const [a, b, want] of rangeCases) {
    const got = fmtCalRange(a, b).replace(/–/g, '-');
    if (got !== want) fail(`fmtCalRange('${a}','${b}') -> '${got}', expected '${want}'`);
  }

  // 3. Malformed input is returned verbatim, never "Invalid Date".
  for (const bad of ['', 'not-a-date', '2026-13-01', '20260910']) {
    if (fmtCalDate(bad) !== bad) fail(`fmtCalDate('${bad}') should echo the input, got '${fmtCalDate(bad)}'`);
    if (/Invalid/.test(fmtCalDate(bad))) fail(`fmtCalDate('${bad}') produced an Invalid Date`);
  }

  // 4. THE REGRESSION ITSELF, made visible. What the naive implementation
  //    would print in this zone, and proof that fmtCalDate does not agree
  //    with it wherever the zone would have shifted the day.
  const probe = '2026-09-10';
  const naive = new Date(probe).toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric' });
  const safe = fmtCalDate(probe);
  console.log(`      naive new Date('${probe}') -> ${naive}${naive === safe ? '' : '   <- would be WRONG here'}`);
  if (naive !== safe && safe !== '10 Sept 2026') {
    fail(`fmtCalDate drifted with the zone: '${safe}'`);
  }

  // 5. fmtDate(Date) is zone-DEPENDENT by contract - it renders the Date in
  //    the ambient zone. Assert it matches that Date's own local parts, which
  //    is the guarantee its call sites rely on.
  const inst = new Date('2026-09-10T12:00:00Z');
  const wantLocal = `${String(inst.getDate()).padStart(2, '0')} ${MONTHS[inst.getMonth()]} ${inst.getFullYear()}`;
  if (fmtDate(inst) !== wantLocal) {
    fail(`fmtDate(Date) -> '${fmtDate(inst)}', expected local parts '${wantLocal}'`);
  }

  // 6. The instant formatters are zone-dependent BY DESIGN (they take an ISO
  //    instant). Assert only that they render a month NAME - never a bare
  //    number-slash form, which is the shape N55 exists to remove.
  const iso = '2026-09-10T12:00:00Z';
  for (const [name, out] of [['fmtDateShort', fmtDateShort(iso)], ['fmtDT', fmtDT(iso)]] as const) {
    if (!MONTHS.some((mo) => out.includes(mo))) fail(`${name}('${iso}') -> '${out}' has no month name`);
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(out)) fail(`${name}('${iso}') -> '${out}' is numeric-slash`);
    if (/\d{4}-\d{2}-\d{2}/.test(out)) fail(`${name}('${iso}') -> '${out}' is ISO`);
  }
  if (!/^\d{2}:\d{2}$/.test(fmtTime(iso))) fail(`fmtTime -> '${fmtTime(iso)}'`);
  if (fmtDuration('2026-09-10T00:00:00Z', '2026-09-10T08:00:00Z') !== '8.0h') {
    fail(`fmtDuration -> '${fmtDuration('2026-09-10T00:00:00Z', '2026-09-10T08:00:00Z')}'`);
  }

  // 7. The value converters must stay zone-invariant when given an explicit
  //    zone - they feed API bounds and <input> values, not display.
  const dz = dayOffsetInZone(0, 'America/Los_Angeles');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dz)) fail(`dayOffsetInZone -> '${dz}' is not YYYY-MM-DD`);
  const zi = isoToZonedInputs('2026-09-10T21:00:00Z', 'America/Los_Angeles');
  if (zi.date !== '2026-09-10' || zi.time !== '14:00') {
    fail(`isoToZonedInputs -> ${JSON.stringify(zi)}, expected 2026-09-10 / 14:00`);
  }
  const back = zonedInputsToISO('2026-09-10', '14:00', 'America/Los_Angeles');
  if (back !== '2026-09-10T21:00:00.000Z') {
    fail(`zonedInputsToISO -> '${back}', expected 2026-09-10T21:00:00.000Z`);
  }
}

// ── Parent: fork one child per zone. Child: run the checks. ───────────────
if (!process.env.N55_ZONE) {
  console.log(`[check-date-format] ${ZONES.length} zones x ${CAL_DATES.length} dates`);
  let bad = 0;
  for (const zone of ZONES) {
    // The child re-enters this same file with TZ set. TZ is read once at
    // process start, so a child per zone is the only way to exercise more
    // than one. ts-node/register because __filename is TypeScript.
    const r = spawnSync(process.execPath, ['-r', 'ts-node/register', __filename], {
      env: {
        ...process.env,
        TZ: zone,
        N55_ZONE: zone,
        TS_NODE_TRANSPILE_ONLY: 'true',
        // Its own tsconfig, not apps/web's: that one targets the Next
        // bundler and conflicts with the CommonJS ts-node needs (TS5095).
        TS_NODE_PROJECT: `${__dirname}/tsconfig.check.json`,
      },
      stdio: 'inherit',
    });
    if (r.status !== 0) bad++;
  }
  if (bad > 0) {
    console.error(`\n[check-date-format] FAIL - ${bad} of ${ZONES.length} zone run(s) failed; see above.`);
    console.error('A day that moved with the zone means a calendar formatter is parsing');
    console.error('the string into a Date. That is the regression N55 exists to prevent.');
    process.exit(1);
  }
  console.log(`\n[check-date-format] PASS - the day never moved, in any of ${ZONES.length} zones.`);
} else {
  checkInThisZone(process.env.N55_ZONE);
  if (failures > 0) process.exit(1);
}
