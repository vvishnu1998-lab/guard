/**
 * N191: the committed hours-export snapshot holds no guard name.
 *
 * Run: npm run check:hours-redaction   (from apps/api; offline, no env, no DATABASE_URL)
 *
 * The repo is public and POLICY.md allows guard data out as "guard_id,
 * company_id, badge, counts only". The snapshot harness (scripts/hours-export-
 * snapshot.ts) reads production, so THIS script is the part that can run
 * anywhere: it proves the committed fixture is name-free and that the
 * redaction the harness applies behaves.
 *
 * It deliberately names NO real person: the fixture is checked by SHAPE (a
 * pseudonym is "Guard GRD0004", a label is that or "Guard GRD0004 @ <site>"),
 * and every string-valued key in the file must be one this contract defines,
 * so a free-text field added later cannot smuggle a name in unnoticed.
 *
 *  1. every guard_name is null or a badge pseudonym; every aggregate label is
 *     the pseudonym, the pseudonym + " @ " + the row's own site_name, or (a
 *     by_site row) the site_name itself;
 *  2. every string-valued key is on the allowlist, and its value has the
 *     right SHAPE (uuid, badge, ISO time, dd/mm/yyyy label, ...);
 *  3. the fixture is a FIXED POINT of the redaction: redact(fixture) equals
 *     fixture byte for byte, which is what makes `--check` compare like with
 *     like once the live build is redacted the same way;
 *  4. the function on a synthetic dataset with made-up names: the names are
 *     gone, nothing else moves, key order is kept, the input is not mutated,
 *     it is idempotent, and a guard with no badge falls back to an id prefix.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { HoursAggregate, HoursExportDataset, HoursExportRow } from '../src/services/hoursExport';
import { guardPseudonym, redactHoursExport } from './hoursExportRedact';

const FIXTURE = path.join(__dirname, '__snapshots__', 'hours-export.2026-07-01_2026-08-23.json');

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL  ${m}`); };
const ok = (m: string) => console.log(`  ok    ${m}`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PSEUDONYM = /^Guard (?:GRD\d{4}|[0-9a-f]{8})$/;
const SHAPES: Record<string, RegExp> = {
  badge_number: /^GRD\d{4}$/,
  guard_id: UUID, site_id: UUID, shift_id: UUID, session_id: UUID, company_id: UUID,
  clock_in_iso: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/, clock_out_iso: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/,
  sched_start_iso: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/, sched_end_iso: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/,
  clock_in_label: /^\d\d\/\d\d\/\d{4}, \d\d:\d\d:\d\d$/, clock_out_label: /^\d\d\/\d\d\/\d{4}, \d\d:\d\d:\d\d$/,
  sched_start_label: /^\d\d\/\d\d\/\d{4}, \d\d:\d\d:\d\d$/, sched_end_label: /^\d\d\/\d\d\/\d{4}, \d\d:\d\d:\d\d$/,
  shift_date: /^\d{4}-\d\d-\d\d$/, start_date: /^\d{4}-\d\d-\d\d$/, end_date: /^\d{4}-\d\d-\d\d$/,
  shift_date_label: /^\d\d\/\d\d\/\d{4}$/, day_of_week: /^[A-Z][a-z]{2}$/,
  site_timezone: /^[A-Za-z_]+\/[A-Za-z_]+$/,
  company_slug: /^[a-z0-9-]+$/,
  flags: /^[A-Z_]+$/,
  // Tenant and site names are organisations and places, not people; guard_name and label are checked below.
  company_name: /^.+$/, site_name: /^.+$/,
  guard_name: PSEUDONYM, label: /^.+$/,
};

type Json = null | string | number | boolean | Json[] | { [k: string]: Json };

function walkStrings(o: Json, key: string, cb: (key: string, value: string, where: string) => void, where: string): void {
  if (typeof o === 'string') { cb(key, o, where); return; }
  if (Array.isArray(o)) { o.forEach((v, i) => walkStrings(v, key, cb, `${where}[${i}]`)); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walkStrings(v as Json, k, cb, `${where}.${k}`);
}

// ── 1 + 2. the committed fixture ──────────────────────────────────────────────
console.log('[check-hours-redaction] the committed fixture');
const raw = fs.readFileSync(FIXTURE, 'utf8');
const fixture = JSON.parse(raw) as Record<string, HoursExportDataset>;

for (const [slug, d] of Object.entries(fixture)) {
  for (const r of d.rows) if (!PSEUDONYM.test(r.guard_name)) fail(`${slug}.rows: guard_name is not a badge pseudonym: ${JSON.stringify(r.guard_name).slice(0, 40)}`);
  for (const sect of ['by_guard', 'by_site', 'by_guard_site'] as const) {
    for (const a of d[sect]) {
      if (a.guard_name !== null && !PSEUDONYM.test(a.guard_name)) fail(`${slug}.${sect}: guard_name is not a badge pseudonym: ${JSON.stringify(a.guard_name).slice(0, 40)}`);
      if (sect === 'by_site') {
        if (a.guard_name !== null || a.guard_id !== null) fail(`${slug}.by_site: a row carries a guard`);
        if (a.label !== a.site_name) fail(`${slug}.by_site: label must be the site name`);
      } else {
        const want = a.site_name ? `${a.guard_name} @ ${a.site_name}` : a.guard_name;
        if (a.label !== want) fail(`${slug}.${sect}: label ${JSON.stringify(a.label).slice(0, 50)} is not the pseudonym${a.site_name ? ' @ site' : ''}`);
      }
    }
  }
  if (d.overall.guard_id !== null || d.overall.guard_name !== null) fail(`${slug}.overall carries a guard`);
}
ok(`${Object.keys(fixture).length} tenants: guard_name and label are pseudonyms or sites only`);

let strings = 0;
walkStrings(fixture as unknown as Json, '', (key, value, where) => {
  strings++;
  const shape = SHAPES[key];
  if (!shape) { fail(`${where}: string value under a key this contract does not define ("${key}"): a free-text field could hold a name`); return; }
  if (key === 'label' || key === 'site_name' || key === 'company_name') return; // free text by design, pinned in section 1 or an organisation/place
  if (!shape.test(value)) fail(`${where}: "${key}" has the wrong shape: ${JSON.stringify(value).slice(0, 40)}`);
}, '$');
ok(`${strings} string values, every key on the allowlist and every value the right shape`);

// ── 3. the fixture is a fixed point of the redaction ─────────────────────────
console.log('[check-hours-redaction] fixed point');
for (const [slug, d] of Object.entries(fixture)) {
  if (JSON.stringify(redactHoursExport(d)) !== JSON.stringify(d)) fail(`${slug}: redact(fixture) differs from the fixture (the harness would report drift on an unchanged database)`);
}
ok('redact(fixture) is byte-identical to the fixture for every tenant');
if (JSON.stringify(fixture, null, 2) + '\n' !== raw) fail('the fixture file is not in the harness\'s own JSON.stringify(…, null, 2) + "\\n" form');
else ok('the file is in the harness\'s own serialisation');

// ── 4. the function, on made-up data ─────────────────────────────────────────
console.log('[check-hours-redaction] the function on a synthetic dataset');
const agg = (over: Partial<HoursAggregate>): HoursAggregate => ({
  guard_id: null, guard_name: null, badge_number: null, site_id: null, site_name: null, label: 'ALL',
  sessions: 1, shifts: 1, scheduled_hours: 8, actual_hours: 8, payable_hours: 8, break_hours: 0, offpost_hours: 0,
  variance_hours: 0, coverage_pct: 100, auto_closed_sessions: 0, flagged_count: 0, ...over,
});
const row = (over: Partial<HoursExportRow>): HoursExportRow => ({
  guard_id: '11111111-1111-4111-8111-111111111111', guard_name: 'Zed Placeholder', badge_number: 'GRD0042',
  site_id: '22222222-2222-4222-8222-222222222222', site_name: 'Example Plaza', site_timezone: 'America/Los_Angeles',
  shift_id: '33333333-3333-4333-8333-333333333333', session_id: '44444444-4444-4444-8444-444444444444',
  shift_date: '2026-08-01', shift_date_label: '01/08/2026', day_of_week: 'Sat',
  sched_start_iso: '2026-08-01T15:00:00.000Z', sched_start_label: '01/08/2026, 08:00:00',
  sched_end_iso: '2026-08-01T23:00:00.000Z', sched_end_label: '01/08/2026, 16:00:00',
  clock_in_iso: '2026-08-01T15:00:00.000Z', clock_in_label: '01/08/2026, 08:00:00',
  clock_out_iso: '2026-08-01T23:00:00.000Z', clock_out_label: '01/08/2026, 16:00:00',
  scheduled_hours: 8, actual_hours: 8, payable_hours: 8, break_hours: 0, offpost_hours: 0,
  variance_hours: 0, coverage_pct: 100, flags: [], ...over,
} as HoursExportRow);
const FAKE_A = { guard_id: '11111111-1111-4111-8111-111111111111', guard_name: 'Zed Placeholder', badge_number: 'GRD0042' };
const FAKE_B = { guard_id: 'abcdef12-1111-4111-8111-111111111111', guard_name: 'Quincy Example', badge_number: null };
const synthetic: HoursExportDataset = {
  company_id: '55555555-5555-4555-8555-555555555555', company_name: 'Example Security', company_slug: 'example-security',
  start_date: '2026-08-01', end_date: '2026-08-01',
  rows: [row({}), row({ ...FAKE_B })],
  by_guard: [agg({ ...FAKE_A, label: 'Zed Placeholder' }), agg({ ...FAKE_B, label: 'Quincy Example' })],
  by_site: [agg({ site_id: '22222222-2222-4222-8222-222222222222', site_name: 'Example Plaza', label: 'Example Plaza' })],
  by_guard_site: [
    agg({ ...FAKE_A, site_id: '22222222-2222-4222-8222-222222222222', site_name: 'Example Plaza', label: 'Zed Placeholder @ Example Plaza' }),
    agg({ ...FAKE_B, site_id: '22222222-2222-4222-8222-222222222222', site_name: 'Example Plaza', label: 'Quincy Example @ Example Plaza' }),
  ],
  overall: agg({}),
};
const before = JSON.stringify(synthetic);
const out = redactHoursExport(synthetic);
const outJson = JSON.stringify(out);
if (JSON.stringify(synthetic) !== before) fail('the input dataset was mutated');
else ok('the input is not mutated');
if (/Zed|Placeholder|Quincy/.test(outJson)) fail('a made-up name survived the redaction');
else ok('made-up names are gone from every section');
eq(out.rows[0].guard_name, 'Guard GRD0042', 'row with a badge');
eq(out.rows[1].guard_name, 'Guard abcdef12', 'row without a badge falls back to an id prefix');
eq(out.by_guard[0].label, 'Guard GRD0042', 'by_guard label');
eq(out.by_guard_site[0].label, 'Guard GRD0042 @ Example Plaza', 'by_guard_site label');
eq(out.by_guard_site[1].label, 'Guard abcdef12 @ Example Plaza', 'by_guard_site label without a badge');
eq(out.by_site[0].label, 'Example Plaza', 'by_site is untouched');
eq(out.overall.label, 'ALL', 'overall is untouched');
eq(guardPseudonym('GRD0001', 'ffffffff-0000-4000-8000-000000000000'), 'Guard GRD0001', 'guardPseudonym');
// Everything except guard_name / label is unchanged, and key order is kept.
const strip = (o: unknown): unknown => Array.isArray(o) ? o.map(strip)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => k !== 'guard_name' && k !== 'label').map(([k, v]) => [k, strip(v)])) : o;
if (JSON.stringify(strip(out)) !== JSON.stringify(strip(synthetic))) fail('the redaction changed something other than guard_name and label');
else ok('nothing but guard_name and label changed');
const keyOrder = (o: object) => Object.keys(o).join(',');
if (keyOrder(out.rows[0]) !== keyOrder(synthetic.rows[0]) || keyOrder(out.by_guard[0]) !== keyOrder(synthetic.by_guard[0])) fail('key order changed (JSON.stringify would no longer match the fixture)');
else ok('key order is kept');
if (JSON.stringify(redactHoursExport(out)) !== outJson) fail('the redaction is not idempotent');
else ok('idempotent');

function eq(got: unknown, want: unknown, label: string): void {
  if (got !== want) fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nOK');
