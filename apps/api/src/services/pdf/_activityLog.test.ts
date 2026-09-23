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
import { renderActivityLogPdf, type ActivityPdfMeta } from './activityLog';
import {
  FIXTURE_ROWS,
  FIXTURE_META,
  FIXTURE_META_PROD_RANGE,
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

  console.log('');
  if (failures > 0) {
    console.error(`FAIL — ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('PASS — all assertions held.');
}

main().catch((e) => { console.error(e); process.exit(1); });
