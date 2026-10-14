/**
 * test-n201-all-sites.ts — GET /api/admin/all-sites also sends each site's zone, and nothing else changes (N201).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n201-all-sites.ts     (from apps/api)
 *
 * The Vishnu companies page counts a contract's days left from today in the site's zone, so the route it
 * reads now selects sites.timezone. Driven over HTTP as it is now and as it was at BASE (main before N201,
 * read from git), on sites in two zones, one with no contract end:
 *
 *   A  every row is BASE's row, value for value and in BASE's order, plus `timezone`, which is the site's own
 *   B  contract_start and contract_end still arrive as BASE sent them (UTC midnight), so the page's
 *      zone-free formatting is what fixes the day, not a change of wire format
 *   M  mutation control: the route without the column has no zone, which A refuses
 *
 * LOCAL DATABASES ONLY; fake sites on Star Guard's id. Sentry, email and S3 are stubbed.
 */
import Module from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
/** main before N201 (PR #120's merge). */
const BASE = '7245a0a95a3cfc175e4a775cbbf58471821fa2ee';
const ADMIN_ROUTES = 'src/routes/admin.ts';

process.env.JWT_SECRET = 'test-only-n201';
process.env.JWT_REFRESH_SECRET = 'test-only-n201-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-n201-vishnu';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  if (process.env.DATABASE_URL) { console.error('REFUSING: DATABASE_URL is set.'); process.exit(2); }
}
function stubModule(name: string, overrides: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...overrides }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the N201 test`); }),
  });
}
function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}
function compileAt(rel: string, src: string): any {
  const file = path.join(__dirname, '..', rel);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}

let failures = 0;
let passes = 0;
let finished = false;
process.on('beforeExit', () => { if (!finished) { console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)'); process.exitCode = 1; } });
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const show = (v: unknown) => JSON.stringify(v);

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  inject('../src/services/s3', stubModule('s3', { urlOrPresign: async (url: string | null) => url }));
  const jwt = (await import('jsonwebtoken')).default;
  const pool = ((await import('../src/db/pool')) as any).pool;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;

  const marker = `lhn201-${Date.now().toString(36)}`;
  const swept = (await q("DELETE FROM sites WHERE name LIKE 'lhn201-%'")).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  const made: string[] = [];
  let server: Server | null = null;
  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    for (const [name, tz, end] of [['Pacific', 'America/Los_Angeles', '2026-12-31'], ['Eastern', 'America/New_York', null]] as const) {
      made.push((await q(`INSERT INTO sites (company_id, name, address, contract_start, contract_end, timezone) VALUES ($1, $2, '1 Example Way', '2026-01-01', $3, $4) RETURNING id`,
        [STAR_GUARD, `${marker} ${name}`, end, tz])).rows[0].id as string);
    }
    const baseSrc = execFileSync('git', ['show', `${BASE}:apps/api/${ADMIN_ROUTES}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    const nowSrc = require('node:fs').readFileSync(path.join(__dirname, '..', ADMIN_ROUTES), 'utf8') as string;
    const app = express();
    app.set('env', 'test');
    app.use(express.json());
    app.use('/api/admin', (await import('../src/routes/admin')).default);
    app.use('/api/admin-base', compileAt(ADMIN_ROUTES, baseSrc).default);
    const noZone = nowSrc.replace('       s.timezone,\n', '');
    if (noZone === nowSrc) throw new Error('the mutant changed nothing');
    app.use('/api/admin-no-zone', compileAt(ADMIN_ROUTES, noZone).default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    const token = jwt.sign({ sub: '00000000-0000-0000-0000-000000000000', role: 'vishnu', iat: Math.floor(Date.now() / 1000) - 5 }, process.env.VISHNU_JWT_SECRET!, { expiresIn: '1h' });
    const get = async (prefix: string) => {
      const r = await fetch(`${origin}${prefix}/all-sites`, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, rows: await r.json() as Array<Record<string, unknown>> };
    };
    /** Each row as BASE would send it, and whether its added zone is the site's own. */
    async function zoneProblems(prefix: string): Promise<string[]> {
      const base = await get('/api/admin-base');
      const now = await get(prefix);
      const problems: string[] = [];
      if (base.status !== 200 || now.status !== 200 || base.rows.length !== now.rows.length) return [`status ${base.status}/${now.status}, rows ${base.rows.length}/${now.rows.length}`];
      for (let i = 0; i < now.rows.length; i += 1) {
        const { timezone, ...rest } = now.rows[i];
        if (show(rest) !== show(base.rows[i])) problems.push(`row ${i} differs beyond the zone`);
        const own = (await q('SELECT timezone FROM sites WHERE id = $1', [now.rows[i].id])).rows[0]?.timezone;
        if (timezone !== own) problems.push(`row ${i}: timezone ${show(timezone)}, the site's ${show(own)}`);
      }
      return problems;
    }

    section('A  every row is BASE\'s row plus the site\'s own zone');
    const a = await zoneProblems('/api/admin');
    const rows = (await get('/api/admin')).rows;
    const ours = rows.filter((r) => made.includes(String(r.id)));
    check(a.length === 0 && ours.length === 2 && show(ours.map((r) => r.timezone)) === '["America/New_York","America/Los_Angeles"]',
      `${rows.length} rows, each BASE's, value for value and in order, plus its timezone; the two fixtures carry Pacific and Eastern (${a.join('; ') || 'all equal'})`);

    section('B  contract dates arrive as BASE sent them');
    const pacific = ours.find((r) => String(r.name).endsWith('Pacific'));
    const eastern = ours.find((r) => String(r.name).endsWith('Eastern'));
    check(pacific?.contract_start === '2026-01-01T00:00:00.000Z' && pacific?.contract_end === '2026-12-31T00:00:00.000Z' && eastern?.contract_end === null,
      `contract_start ${show(pacific?.contract_start)}, contract_end ${show(pacific?.contract_end)} and null: UTC midnight, the wire format the page now reads by its date part`);

    section('M  mutation control');
    const m = await zoneProblems('/api/admin-no-zone');
    check(m.length > 0, `control — the route without the column: ${m.length} problem${m.length === 1 ? '' : 's'} (${m[0] ?? 'none'}), which A refuses`);
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    if (made.length) await q('DELETE FROM sites WHERE id = ANY($1::uuid[])', [made]);
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q('SELECT count(*)::int AS n FROM sites WHERE name LIKE $1', [`${marker}%`])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
    await pool.end();
  }
  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR', err); process.exit(1); });
