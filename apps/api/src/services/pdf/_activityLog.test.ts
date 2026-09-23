/**
 * Tests for renderActivityLogPdf.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && TZ=UTC npx ts-node src/services/pdf/_activityLog.test.ts
 *
 * TZ=UTC IS NOT OPTIONAL AND THE SCRIPT REFUSES TO RUN WITHOUT IT.
 * Railway sets no TZ, so the API process runs in UTC; the period header is
 * formatted with a bare toLocaleDateString, which means it renders in the
 * SERVER's zone. On a workstation in America/Los_Angeles that call happens
 * to produce the right answer, so the defect it encodes is invisible and a
 * test written on a laptop would pass against broken code. Rather than
 * document that, the check below fails loudly — the same reasoning as
 * REQUIRE_DB in scripts/check-window-anchor.ts, where a silent skip once
 * produced a permanently green check that verified nothing.
 *
 * Assertions read the rendered document, not the code: every check goes
 * through poppler (pdfinfo / pdftotext), so a change that compiles but
 * moves nothing on the page cannot pass.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  renderActivityLogPdf, STATUS_COLOR, STATUS_LABEL,
  type ActivityPdfMeta,
} from './activityLog';
import {
  FIXTURE_ROWS,
  FIXTURE_ROWS_ONE_PAGE,
  FIXTURE_META,
  FIXTURE_META_PROD_RANGE,
  FIXTURE_META_WITH_SHIFT,
  ALL_STATUS_KINDS,
} from './_activityLogFixture';

if (process.env.TZ !== 'UTC') {
  console.error(
    `FAIL — this suite must run with TZ=UTC (got ${process.env.TZ ?? '<unset>'}).\n` +
    '       Railway runs UTC; the period-header defect does not reproduce in PT.\n' +
    '       cd apps/api && TZ=UTC npx ts-node src/services/pdf/_activityLog.test.ts',
  );
  process.exit(1);
}

// ── Harness ──────────────────────────────────────────────────────────────────
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-pdf-'));

let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); }
}

async function render(name: string, rows = FIXTURE_ROWS, meta: ActivityPdfMeta = FIXTURE_META) {
  // Spread: the renderer sorts in place, and a shared fixture array must not
  // carry one test's ordering into the next.
  const buf  = await renderActivityLogPdf([...rows], meta);
  const file = path.join(OUT_DIR, `${name}.pdf`);
  fs.writeFileSync(file, buf);
  return {
    file,
    pages: Number(
      execFileSync('pdfinfo', [file], { encoding: 'utf8' })
        .split('\n').find((l) => l.startsWith('Pages:'))!.split(/\s+/)[1],
    ),
    text: execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }),
    /** 1-indexed single page, for assertions that must not match elsewhere. */
    page: (n: number) =>
      execFileSync('pdftotext', ['-layout', '-f', String(n), '-l', String(n), file, '-'],
                   { encoding: 'utf8' }),
  };
}

async function main() {
  console.log(`renderActivityLogPdf — output in ${OUT_DIR}`);
  console.log('');

  const doc = await render('fixture');

  console.log('fixture integrity');
  check('fixture enumerates every StatusKind exactly once', () => {
    assert.strictEqual(new Set(ALL_STATUS_KINDS).size, ALL_STATUS_KINDS.length, 'duplicate kind');
    const rendered = new Set(FIXTURE_ROWS.map((r) => r.status_kind));
    const missing  = ALL_STATUS_KINDS.filter((k) => !rendered.has(k));
    assert.deepStrictEqual(missing, [], `kinds with no fixture row: ${missing.join(', ')}`);
  });

  console.log('');
  console.log('renders at all');
  check('a null-severity incident renders without throwing', () => {
    // Guarded explicitly: severity is NULL on 13 of 13 production incidents,
    // and an unguarded .toUpperCase() on it took out every incident alert
    // (PR #74). The renderer must never acquire the same assumption.
    const incident = FIXTURE_ROWS.find((r) => r.status_kind === 'incident_report' && r.severity === null);
    assert.ok(incident, 'fixture lost its null-severity incident');
    assert.ok(doc.text.length > 0, 'no text extracted');
    assert.ok(!/\bnull\b|\bundefined\b/i.test(doc.text), 'null/undefined leaked into the document');
  });

  check('produces a multi-page document (3+ pages)', () => {
    assert.ok(doc.pages >= 3, `expected 3+ pages, got ${doc.pages}`);
  });

  check('cover reports the uncapped row total', () => {
    assert.match(doc.page(1), new RegExp(`\\b${FIXTURE_ROWS.length}\\b[\\s\\S]{0,400}TOTAL EVENTS`));
  });

  // ── C1 / D2 — the period renders in SITE time, not server time ────────────
  console.log('');
  console.log('C1 — period header (D2)');

  const prod = await render('prod-range', FIXTURE_ROWS, FIXTURE_META_PROD_RANGE);

  check('period end is the picker date, not the next UTC day', () => {
    // Picker 2026-08-24 -> 2026-09-22. Wire end is 2026-09-23T06:59:59.999Z,
    // which a zone-less formatter on a UTC server renders as 23/09.
    const period = prod.page(1).split('\n').find((l) => l.includes('Period'));
    assert.ok(period, 'no Period line on the cover');
    assert.match(period, /22\/09\/2026/, `period end wrong: ${period.trim()}`);
    assert.doesNotMatch(period, /23\/09\/2026/, `period end is the next UTC day: ${period.trim()}`);
  });

  check('period start is unchanged (07:00Z is already the right day)', () => {
    const period = prod.page(1).split('\n').find((l) => l.includes('Period'))!;
    assert.match(period, /24\/08\/2026/, `period start wrong: ${period.trim()}`);
  });

  check('the footer carries the same corrected period on every page', () => {
    // drawFooter stamps periodStr on all pages; a fix applied only to the
    // cover would leave every other page contradicting it.
    for (let p = 1; p <= prod.pages; p++) {
      assert.doesNotMatch(prod.page(p), /23\/09\/2026/, `page ${p} footer still says 23/09`);
    }
  });

  check('the end date matches the filename the same click produces', () => {
    // routes/admin.ts builds `activity-logs-${fromIso.slice(0,10)}_...`, and
    // the web builds the same name from the raw picker string. Header and
    // filename disagreeing is the symptom a reader actually reported.
    const period = prod.page(1).split('\n').find((l) => l.includes('Period'))!;
    const webFilenameEnd = '2026-09-22';                 // ActivityLogTable.tsx:613
    const [y, m, d] = webFilenameEnd.split('-');
    assert.match(period, new RegExp(`${d}/${m}/${y}`), 'header disagrees with the filename');
  });

  // ── C2 / D3 — the declared page total is the real one ─────────────────────
  console.log('');
  console.log('C2 — page total (D3)');

  const one = await render('one-page', FIXTURE_ROWS_ONE_PAGE);

  /** Every "n / N" the chrome prints, one per page. */
  function declaredTotals(d: { pages: number; page: (n: number) => string }): number[] {
    const out: number[] = [];
    for (let p = 1; p <= d.pages; p++) {
      const m = d.page(p).match(/(\d+)\s*\/\s*(\d+)/);
      assert.ok(m, `page ${p} prints no "n / N"`);
      assert.strictEqual(Number(m[1]), p, `page ${p} numbers itself ${m[1]}`);
      out.push(Number(m[2]));
    }
    return out;
  }

  check('multi-page: declared total equals pdfinfo Pages', () => {
    const totals = declaredTotals(doc);
    assert.deepStrictEqual(
      [...new Set(totals)], [doc.pages],
      `pdfinfo says ${doc.pages}, pages declare ${JSON.stringify(totals)}`,
    );
  });

  check('one-page: declared total equals pdfinfo Pages', () => {
    // The old estimate's floor was 2, so this case was unreachable.
    assert.strictEqual(one.pages, 1, `fixture is no longer one page (${one.pages})`);
    assert.deepStrictEqual(declaredTotals(one), [1], 'a one-page document must say 1 / 1');
  });

  check('no page is left un-numbered', () => {
    for (let p = 1; p <= doc.pages; p++) {
      assert.match(doc.page(p), /\d+\s*\/\s*\d+/, `page ${p} has no chrome`);
    }
  });

  // ── C3 / D1 — the header names the shift filter ───────────────────────────
  console.log('');
  console.log('C3 — shift filter in the header (D1)');

  const shifted = await render('with-shift', FIXTURE_ROWS, FIXTURE_META_WITH_SHIFT);

  check('a shift-filtered export prints a Shift line', () => {
    const line = shifted.page(1).split('\n').find((l) => /^\s*Shift\b/.test(l));
    assert.ok(line, 'no Shift line on the cover of a session-filtered export');
    assert.match(line, /Fixture Guard A/, `Shift line names no guard: ${line.trim()}`);
    assert.match(line, /Bethel AME Church/, `Shift line names no site: ${line.trim()}`);
    // 19:00:14Z is 12:00 PT. A server-zone render would say 19:00.
    assert.match(line, /12:00/, `Shift clock-in not in site time: ${line.trim()}`);
    assert.doesNotMatch(line, /19:00/, `Shift clock-in rendered in UTC: ${line.trim()}`);
  });

  check('an unfiltered export prints no Shift line', () => {
    const line = doc.page(1).split('\n').find((l) => /^\s*Shift\b/.test(l));
    assert.strictEqual(line, undefined, `Shift line present with no session filter: ${line}`);
  });

  check('a filtered export never claims to be unfiltered', () => {
    // The whole of D1: the 19-event export was scoped to ONE session and its
    // header read "Guard: All guards", so a reader had no way to know two
    // guards had worked that site that day and only one was in the document.
    assert.doesNotMatch(shifted.page(1), /All guards/,
      'cover still claims "All guards" while scoped to one session');
  });

  // ── C4 — every status kind gets a label and a colour ──────────────────────
  console.log('');
  console.log('C4 — status maps (audit anomaly 2)');

  const MUTED = '#64748B';

  check('every StatusKind has a label', () => {
    const missing = ALL_STATUS_KINDS.filter((k) => !STATUS_LABEL[k]);
    assert.deepStrictEqual(missing, [], `kinds falling back to r.status: ${missing.join(', ')}`);
  });

  check('every StatusKind has a colour, and none is the muted fallback', () => {
    const missing = ALL_STATUS_KINDS.filter((k) => !STATUS_COLOR[k]);
    assert.deepStrictEqual(missing, [], `kinds with no colour: ${missing.join(', ')}`);
    const muted = ALL_STATUS_KINDS.filter((k) => STATUS_COLOR[k] === MUTED);
    assert.deepStrictEqual(muted, [], `kinds rendering muted grey: ${muted.join(', ')}`);
  });

  check('an unmet obligation is red wherever it appears', () => {
    // MISSED PING was red while MISSED CLOCK IN and MISSED REPORT fell through
    // to grey. A missed clock-in is the most serious row in the document and
    // was the least visually salient thing on the page.
    for (const k of ['missed', 'missed_clock_in', 'missed_report', 'missed_answered_late'] as const) {
      assert.strictEqual(STATUS_COLOR[k], '#DC2626', `${k} is not red`);
    }
  });

  check('a late clock-in is distinguishable from an on-time one', () => {
    // Both rows carry status 'Clocked In', so the label fallback rendered
    // them identically — the PDF could not tell an admin which was which.
    assert.notStrictEqual(STATUS_LABEL.clocked_in_late, STATUS_LABEL.clocked_in_on_time,
      'both clock-in kinds render the same label');
    assert.notStrictEqual(STATUS_COLOR.clocked_in_late, STATUS_COLOR.clocked_in_on_time,
      'both clock-in kinds render the same colour');
  });

  check('every label actually reaches the page', () => {
    for (const k of ALL_STATUS_KINDS) {
      assert.ok(doc.text.includes(STATUS_LABEL[k]),
        `${k} -> "${STATUS_LABEL[k]}" appears nowhere in the rendered document`);
    }
  });

  // ── C5 — the time column tells the truth about its own sort key ───────────
  console.log('');
  console.log('C5 — time column (D4 + D5 + D6)');

  /** Leading HH:MM of every timeline row, in page order. */
  function rowTimes(d: { text: string }): string[] {
    return d.text.split('\n')
      .map((l) => l.match(/^\s{0,8}(\d{2}:\d{2}|—)\s{2,}\S/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]);
  }

  check('no row prints an em-dash for its time', () => {
    const dashes = rowTimes(doc).filter((t) => t === '—');
    assert.strictEqual(dashes.length, 0,
      `${dashes.length} rows still print "—" instead of their scheduled time`);
  });

  check('synthesized rows print their scheduled time, marked as scheduled', () => {
    // missed / missed_report / missed_clock_in have log_time null and carry
    // the window (or hour, or scheduled_start) in event_time all along. The
    // renderer simply never looked at it.
    for (const label of ['MISSED PING', 'MISSED REPORT', 'MISSED CLOCK IN']) {
      const line = doc.text.split('\n').find((l) => l.includes(label));
      assert.ok(line, `no ${label} row`);
      assert.match(line, /^\s*\d{2}:\d{2}/, `${label} has no time: ${line.trim()}`);
    }
    assert.match(doc.text, /SCHED/, 'nothing marks a time as scheduled rather than observed');
  });

  check('the merged row sorts AND prints at its window, not its answer', () => {
    // The whole of D4. event_time is the 13:00 window; log_time is the
    // 15:17:34 ping that answered it. Printing log_time while sorting on
    // event_time put "15:17" between 12:31 and 13:03.
    const line = doc.text.split('\n').find((l) => l.includes('MISSED / ANSWERED LATE'));
    assert.ok(line, 'no merged row');
    assert.match(line, /^\s*13:00/, `merged row prints ${line.trim().slice(0, 12)}, not its window`);
  });

  check('15:17 in the time column belongs only to the 15:17 report', () => {
    // Before: "15:17" appeared TWICE in one day, four rows apart — once from
    // the merged row and once from an unrelated activity report.
    const at1517 = rowTimes(doc).filter((t) => t === '15:17');
    assert.strictEqual(at1517.length, 1, `${at1517.length} rows print 15:17 in the time column`);
  });

  check('the answer time and lateness survive, in the status text', () => {
    assert.match(doc.text, /answered 108 minutes late/,
      'the merged row lost "Missed — answered 108 minutes late" to its short badge');
  });

  check('two pings in the same minute are told apart', () => {
    // Two real DB rows 12.7s apart answering DIFFERENT windows. Both print
    // 16:32, so the badge alone made them look like one event duplicated.
    // They are separated by the LATE badge plus its qualifier; the on-time
    // one is deliberately bare (see 'on_time rows are one line' below).
    const lines = doc.text.split('\n').filter((l) => /^\s*16:32/.test(l));
    assert.strictEqual(lines.length, 2, `expected 2 rows at 16:32, got ${lines.length}`);
    const late   = lines.filter((l) => l.includes('LATE PING'));
    const onTime = lines.filter((l) => /PING/.test(l) && !l.includes('LATE PING'));
    assert.strictEqual(late.length, 1,   'no LATE PING row at 16:32');
    assert.strictEqual(onTime.length, 1, 'no plain PING row at 16:32');
    assert.match(doc.text, /Late Ping \(32 minutes\)/,
      'the 16:00-window backfill carries no qualifier, so the pair is ambiguous');
  });

  check('on_time ping rows are one line — no qualifier', () => {
    // Every ping row carrying a qualifier took a full export from 90 to 122
    // pages. A routine on-time ping is the bulk of the document and its
    // badge already says everything.
    for (const m of ['Ping (0 minutes)', 'Ping (1 minute)', 'Ping (2 minutes)', 'Ping (3 minutes)']) {
      assert.ok(!doc.text.includes(m), `on_time row still prints its qualifier: "${m}"`);
    }
  });

  check('a qualifier that only restates its badge is dropped', () => {
    // 'Missed Ping' / 'Missed Report' / 'Missed Clock In' ARE the badge
    // labels, so printing them would add a line that says nothing.
    for (const m of ['Missed Ping', 'Missed Report', 'Missed Clock In']) {
      const asQualifier = doc.text.split('\n').filter((l) => l.trim() === m);
      assert.strictEqual(asQualifier.length, 0,
        `"${m}" printed as a qualifier line, restating its own badge`);
    }
  });

  check('a late clock-in carries its delta, as the web shows it', () => {
    assert.match(doc.text, /\+18m late/, 'no "+Nm late" on the late clock-in row');
  });

  console.log('');
  if (failures > 0) {
    console.error(`FAIL — ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('PASS — all assertions held.');
}

main().catch((e) => { console.error(e); process.exit(1); });
