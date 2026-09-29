/**
 * Tests for renderIncidentAlert's null-severity handling.
 *
 * `reports.severity` is `character varying(20)` NULL-able and NOTHING writes
 * it: 1096 of 1096 production rows are NULL, including 13 of 13 incidents.
 * `renderIncidentAlert` nevertheless typed it `string` and called
 * `.toUpperCase()` on it unguarded, so every incident alert threw
 *
 *   TypeError: Cannot read properties of null (reading 'toUpperCase')
 *
 * before a single send. Observed twice in production on 2026-09-23
 * (02:18:27.151Z and 02:19:59.057Z) against reports 4a7a3be7 and c16a6ed8.
 *
 * THE THROW IS SYNCHRONOUS AND THAT IS THE POINT. The render happens inside
 * the `.map` callback that BUILDS the array argument to `Promise.allSettled`
 * (email.ts), so it escapes before allSettled exists to settle it. The
 * "one bad recipient must not suppress the others" guarantee in the comment
 * there does not apply: one NULL severity suppressed EVERY recipient. So the
 * assertion below is NO-THROW, not a rejected promise — a test that awaited a
 * settled rejection would pass against the broken code.
 *
 * Two properties, matching the two directions this can regress:
 *   - severity NULL renders without throwing, emits no severity badge, keeps
 *     the timestamp span, and leaks neither "NULL" nor "undefined" into the
 *     html or the subject;
 *   - severity 'high' is BYTE-IDENTICAL to the pre-fix renderer. The baseline
 *     in __snapshots__/incidentAlert.high.json was captured from main at
 *     c70153a BEFORE the fix was written, so this genuinely pins the old
 *     output rather than blessing the new one.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/services/_incidentAlert.test.ts
 *
 * Re-capture the baseline (only valid on the PRE-FIX renderer):
 *   cd apps/api && CAPTURE_BASELINE=1 npx ts-node src/services/_incidentAlert.test.ts
 */
import assert from 'node:assert';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}

// email.ts runs module-level side effects on import: sgMail.setApiKey and a
// hard throw if SENDGRID_FROM_EMAIL is unset. Both are stubbed/satisfied so the
// module loads in isolation without touching the network or the database.
// CLIENT_PORTAL_URL is pinned so the deep link is deterministic across machines
// — without it PORTAL falls back to '' and the snapshot would encode the
// capturing machine's environment.
process.env.SENDGRID_FROM_EMAIL = 'alerts@example.invalid';
process.env.SENDGRID_API_KEY = 'stub-key-sgMail-is-injected';
process.env.CLIENT_PORTAL_URL = 'https://portal.example.invalid/client/';
inject('../services/sentry', {
  Sentry: new Proxy({}, { get: () => () => 'stub' }),
});
inject('../db/pool', { pool: { query: async () => ({ rows: [], rowCount: 0 }) } });
inject('@sendgrid/mail', { __esModule: true, default: { setApiKey() {}, async send() {} } });

const { renderIncidentAlert } = require('./email') as typeof import('./email');

// Fixed instant + explicit tz so the rendered date/time never depends on when
// or where the test runs. Description carries an angle bracket and an ampersand
// so the snapshot also pins escapeHtml's behaviour.
const BASE = {
  report_id:    '00000000-0000-0000-0000-000000000001',
  description:  'Unlocked door at the north entrance. <b>Not</b> forced & no damage.',
  reported_at:  new Date('2026-09-23T02:19:49.818Z'),
  site_name:    'Test Site',
  site_tz:      'America/Los_Angeles',
  client_name:  'jane doe',
  company_name: 'Test Company',
};

const SNAPSHOT = path.join(__dirname, '__snapshots__', 'incidentAlert.high.json');

// The severity badge span is identified by `padding:3px 10px`, which appears
// exactly once in email.ts. Matching on the padding rather than on the label
// text means the assertion still holds if the label copy changes.
const BADGE_MARKER = 'padding:3px 10px';

// ── Baseline capture (pre-fix renderer only) ────────────────────────────────
if (process.env.CAPTURE_BASELINE === '1') {
  const out = renderIncidentAlert({ ...BASE, severity: 'high' } as Parameters<typeof renderIncidentAlert>[0]);
  fs.writeFileSync(SNAPSHOT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[capture] wrote ${SNAPSHOT}`);
  console.log(`[capture] subject: ${out.subject}`);
  console.log(`[capture] html bytes: ${Buffer.byteLength(out.html, 'utf8')}`);
  process.exit(0);
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message.split('\n')[0]}`);
  }
}

console.log('renderIncidentAlert — severity NULL');

// The regression itself. Once the type is widened to `string | null` this
// call is well-typed; against the pre-fix `string` it does not compile, which
// is why the baseline was captured with --transpile-only.
let nullOut!: { subject: string; html: string };
check('does not throw when severity is null', () => {
  nullOut = renderIncidentAlert({ ...BASE, severity: null });
});

check('emits no severity badge span', () => {
  assert.ok(
    !nullOut.html.includes(BADGE_MARKER),
    `html still contains the badge marker ${BADGE_MARKER}`,
  );
});

check('keeps the timestamp span', () => {
  // fmtDTSite output for the fixed instant in America/Los_Angeles.
  assert.ok(
    nullOut.html.includes('22 Sep 2026'),
    'html lost the timestamp span',
  );
});

check('leaks neither NULL nor undefined into the html', () => {
  for (const needle of ['NULL', 'undefined', 'null']) {
    assert.ok(
      !nullOut.html.includes(needle),
      `html contains ${JSON.stringify(needle)}`,
    );
  }
});

check('leaks neither NULL nor undefined into the subject', () => {
  for (const needle of ['NULL', 'undefined', 'null']) {
    assert.ok(
      !nullOut.subject.includes(needle),
      `subject contains ${JSON.stringify(needle)}`,
    );
  }
});

check('subject drops the severity segment', () => {
  assert.strictEqual(nullOut.subject, 'Incident Reported — Test Site — 22 Sept 2026');
});

console.log('renderIncidentAlert — severity "high" (byte-compare vs main@c70153a)');

check('baseline snapshot exists', () => {
  assert.ok(fs.existsSync(SNAPSHOT), `missing ${SNAPSHOT}`);
});

check('html and subject are byte-identical to the pre-fix renderer', () => {
  const baseline = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as {
    subject: string; html: string;
  };
  const actual = renderIncidentAlert({ ...BASE, severity: 'high' });

  assert.strictEqual(actual.subject, baseline.subject, 'subject drifted');
  assert.strictEqual(
    Buffer.compare(Buffer.from(actual.html, 'utf8'), Buffer.from(baseline.html, 'utf8')),
    0,
    'html drifted',
  );
});

console.log('');
if (failures > 0) {
  console.error(`FAIL — ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('PASS — all assertions held.');
