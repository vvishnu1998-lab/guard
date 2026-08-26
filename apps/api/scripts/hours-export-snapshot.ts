/**
 * Snapshot harness for the hours export contract.
 *
 *   npm run script:hours-snapshot -- --write   # regenerate the fixture
 *   npm run script:hours-snapshot -- --check   # fail non-zero on any drift
 *
 * There is no test framework in this repo, so this follows the existing
 * scripts/*.ts + ts-node convention rather than inventing one.
 *
 * NOT HERMETIC — it reads production. That is a deliberate trade: a seeded
 * fixture database is a much larger build, and the value here is catching a
 * change in the CONTRACT, which only real rows exercise. Two things keep it
 * stable anyway:
 *
 *   * The range is pinned to a CLOSED window, 2026-07-01..2026-08-23. No
 *     session can be added to a past window, so the fixture cannot drift
 *     from live traffic the way a trailing range would.
 *   * The contract emits no NOW(), so two runs of the same range must be
 *     byte-identical. --check asserts that directly by building twice.
 *
 * It also asserts the aggregate invariant that the handoff split exists to
 * preserve: Σ by_guard == Σ by_site == overall, for every hours field.
 */

import { pool } from '../src/db/pool';
import { buildHoursExport, type HoursExportDataset } from '../src/services/hoursExport';

const START = '2026-07-01';
const END   = '2026-08-23';
const TENANTS: Array<{ slug: string; company_id: string }> = [
  { slug: 'star-guard',       company_id: 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee' },
  { slug: 'starnet-security',  company_id: '27c4d404-8769-49ca-bfd6-93cb9b890067' },
];
const FIXTURE = `${__dirname}/__snapshots__/hours-export.${START}_${END}.json`;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function assertAggregateInvariant(slug: string, d: HoursExportDataset): string[] {
  const fields = ['scheduled_hours', 'actual_hours', 'break_hours', 'offpost_hours'] as const;
  const problems: string[] = [];
  for (const f of fields) {
    const g = round2(d.by_guard.reduce((s, a) => s + a[f], 0));
    const s = round2(d.by_site.reduce((s2, a) => s2 + a[f], 0));
    const gs = round2(d.by_guard_site.reduce((s2, a) => s2 + a[f], 0));
    const o = round2(d.overall[f]);
    if (g !== o)  problems.push(`${slug}: Σ by_guard.${f} ${g} !== overall ${o}`);
    if (s !== o)  problems.push(`${slug}: Σ by_site.${f} ${s} !== overall ${o}`);
    if (gs !== o) problems.push(`${slug}: Σ by_guard_site.${f} ${gs} !== overall ${o}`);
  }
  return problems;
}

async function collect(): Promise<Record<string, HoursExportDataset>> {
  const out: Record<string, HoursExportDataset> = {};
  for (const t of TENANTS) {
    out[t.slug] = await buildHoursExport({
      company_id: t.company_id, start_date: START, end_date: END,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--write') ? 'write'
             : process.argv.includes('--check') ? 'check'
             : null;
  if (!mode) {
    console.error('usage: hours-export-snapshot.ts --write | --check');
    process.exit(2);
  }

  const fs = await import('fs');
  const first = await collect();

  const problems: string[] = [];
  for (const [slug, d] of Object.entries(first)) problems.push(...assertAggregateInvariant(slug, d));

  if (mode === 'check') {
    // Determinism: the contract emits no NOW(), so a second build of the same
    // closed range must be byte-identical to the first.
    const second = await collect();
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      problems.push('NON-DETERMINISTIC: two builds of the same range differ — a NOW() reached the output');
    }
    if (!fs.existsSync(FIXTURE)) {
      problems.push(`fixture missing: ${FIXTURE} (run --write)`);
    } else {
      const saved = fs.readFileSync(FIXTURE, 'utf8');
      const now   = JSON.stringify(first, null, 2) + '\n';
      if (saved !== now) {
        problems.push('DRIFT: dataset differs from the committed fixture');
        const a = saved.split('\n'), b = now.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length) && problems.length < 12; i += 1) {
          if (a[i] !== b[i]) problems.push(`  line ${i + 1}:\n    fixture: ${a[i]}\n    actual:  ${b[i]}`);
        }
      }
    }
  }

  if (problems.length) {
    console.error('FAIL');
    for (const p of problems) console.error('  ' + p);
    await pool.end();
    process.exit(1);
  }

  if (mode === 'write') {
    fs.writeFileSync(FIXTURE, JSON.stringify(first, null, 2) + '\n');
    console.log(`wrote ${FIXTURE}`);
  }
  for (const [slug, d] of Object.entries(first)) {
    console.log(`  ${slug}: ${d.rows.length} rows | scheduled ${d.overall.scheduled_hours} | actual ${d.overall.actual_hours} | break ${d.overall.break_hours} | offpost ${d.overall.offpost_hours}`);
  }
  console.log(mode === 'check' ? 'OK — deterministic, invariants hold, no drift' : 'OK');
  await pool.end();
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
