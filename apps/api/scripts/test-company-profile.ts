/**
 * test-company-profile.ts — /api/admin/company (Phase A), end to end over HTTP
 * on a THROWAWAY LOCAL Postgres with the chain replayed through schema_v82.
 *
 * Runs the REAL router behind express.json() and the REAL requireAuth: JWTs are
 * signed here with a test-only JWT_SECRET, and the middleware's company_admins
 * re-read hits the test database. Sentry, email and S3 are replaced in
 * require.cache before anything loads. The S3 stub records every call; any S3
 * or email function the routes are not expected to use throws.
 *
 * LOCAL DATABASES ONLY. Refuses unless PGHOST is 127.0.0.1 or localhost and
 * PGDATABASE ends in "test", refuses a DATABASE_URL that points anywhere else,
 * and re-asserts after import that the app pool carries no connection string.
 * Writes two marker companies with their admins and deletes them at the end
 * unless --keep is passed; their audit rows go with them (ON DELETE CASCADE).
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=cp_test \
 *     npx ts-node scripts/test-company-profile.ts          (from apps/api)
 *
 * Checks never stop at the first failure; the exit code is the verdict.
 */
import Module from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const KEEP = process.argv.includes('--keep');
const JWT_SECRET = 'test-only-company-profile';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) {
    console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`);
    process.exit(2);
  }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) {
    console.error('REFUSING: PGDATABASE must end in "test".');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (url) {
    let urlHost = '';
    try { urlHost = new URL(url).hostname; } catch { urlHost = '(unparseable)'; }
    if (!LOCAL_HOSTS.has(urlHost)) {
      console.error(`REFUSING: DATABASE_URL points at ${urlHost}; unset it or point it at localhost.`);
      process.exit(2);
    }
  }
}

function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}
/** A module whose listed members work and whose every other member throws when called. */
function stubModule(name: string, members: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...members }, {
    get: (target, prop) => (prop in target
      ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the company-profile test`); }),
  });
}

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const show = (v: unknown): string => JSON.stringify(v);
const ms = (v: unknown): number => (v === null || v === undefined ? NaN : new Date(v as string).getTime());

interface Reply { status: number; body: any }

async function main(): Promise<void> {
  refuseUnlessLocal();
  process.env.JWT_SECRET = JWT_SECRET;

  inject('../src/services/sentry', {
    Sentry: {
      captureMessage: () => 'evt',
      captureException: () => 'evt',
      addBreadcrumb: () => undefined,
      withScope: (fn: (s: unknown) => void) => fn({ setTag: () => undefined, setExtra: () => undefined }),
    },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  const presignedKeys: string[] = [];
  inject('../src/services/s3', stubModule('s3', {
    urlOrPresign: async (stored: string | null | undefined) => {
      if (!stored) return null;
      const key = stored.replace(/^https?:\/\/[^/]+\//, '');
      presignedKeys.push(key);
      return `https://signed.test/${key}?X-Amz-Expires=900`;
    },
  }));

  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) {
    console.error('REFUSING: the app pool carries a connection string; unset DATABASE_URL.');
    process.exit(2);
  }
  await import('express-async-errors');   // as index.ts does, before any request
  const express = (await import('express')).default;
  const router = (await import('../src/routes/companyProfile')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/admin/company', router);
  const thrown: unknown[] = [];
  app.use((err: unknown, _req: unknown, res: any, _next: unknown) => {
    thrown.push(err);
    res.status(500).json({ error: 'internal (harness error handler)' });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/company`;

  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `cp-${Date.now().toString(36)}`;
  const companyIds: string[] = [];
  const replies: Reply[] = [];

  async function call(method: string, path: string, token: string | null, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: string | FormData | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + path, { method, headers, body: payload });
    const text = await r.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    const reply = { status: r.status, body: parsed };
    replies.push(reply);
    return reply;
  }

  try {
    // ── fixtures ──────────────────────────────────────────────────────────
    async function mkCompany(tag: string): Promise<string> {
      const id = (await q('INSERT INTO companies (name) VALUES ($1) RETURNING id', [`${marker}-${tag}`])).rows[0].id;
      companyIds.push(id);
      return id;
    }
    async function mkAdmin(companyId: string, tag: string, isPrimary: boolean, isActive = true): Promise<string> {
      return (await q(
        `INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, is_active)
         VALUES ($1, $2, $3, 'x', $4, $5) RETURNING id`,
        [companyId, `${marker} ${tag}`, `${marker}-${tag}@test.invalid`, isPrimary, isActive])).rows[0].id;
    }
    const companyA = await mkCompany('A');
    const companyB = await mkCompany('B');
    const primaryA = await mkAdmin(companyA, 'pa', true);
    const secondA = await mkAdmin(companyA, 'sa', false);
    const inactiveA = await mkAdmin(companyA, 'ia', false, false);
    const primaryB = await mkAdmin(companyB, 'pb', true);
    const sign = (sub: string, companyId: string, claimPrimary: boolean, role = 'company_admin'): string =>
      jwt.sign({ sub, role, company_id: companyId, is_primary: claimPrimary }, JWT_SECRET, { expiresIn: '1h' });
    // The JWT claims are deliberately WRONG for A's two admins: the secondary
    // claims primary and the primary claims not. The routes must read the DB.
    const tPrimaryA = sign(primaryA, companyA, false);
    const tSecondA = sign(secondA, companyA, true);
    const tInactiveA = sign(inactiveA, companyA, false);
    const tPrimaryB = sign(primaryB, companyB, true);
    const tGuard = sign(primaryA, companyA, true, 'guard');

    const companyRow = async (id: string) => (await q('SELECT * FROM companies WHERE id = $1', [id])).rows[0];
    const auditRows = async (id: string) => (await q(
      'SELECT * FROM company_profile_audit WHERE company_id = $1 ORDER BY created_at, field', [id])).rows;
    const PROFILE = ['contact_email', 'phone', 'address', 'licence_number', 'website'] as const;
    const profileOf = async (id: string) => {
      const r = await companyRow(id);
      return Object.fromEntries(PROFILE.map((f) => [f, r[f]]));
    };

    // ══════════════════════════════════════════════════════════════════════
    section('G  GET /api/admin/company');
    {
      const r = await call('GET', '', tPrimaryA);
      check(r.status === 200, `G1 primary: 200 (got ${r.status} ${show(r.body)})`);
      check(r.body?.id === companyA && r.body?.name === `${marker}-A`, 'G1 returns the caller\'s company (id, name)');
      check(r.body?.is_primary === true, 'G1 is_primary true from the DB although the JWT claims false');
      check(PROFILE.every((f) => r.body?.[f] === null), 'G1 the five fields start null');
      check(r.body?.logo_url === null && r.body?.logo_updated_at === null && r.body?.updated_at === null, 'G1 logo_url, logo_updated_at, updated_at null');
      check(show(Object.keys(r.body ?? {}).sort()) === show(['address', 'contact_email', 'id', 'is_primary', 'licence_number', 'logo_updated_at', 'logo_url', 'name', 'phone', 'updated_at', 'website']),
        `G1 exactly the documented keys (got ${show(Object.keys(r.body ?? {}).sort())})`);
    }
    {
      const r = await call('GET', '', tSecondA);
      check(r.status === 200 && r.body?.is_primary === false, `G2 secondary: 200, is_primary false from the DB although the JWT claims true (got ${r.status} ${show(r.body?.is_primary)})`);
    }
    {
      const r = await call('GET', '', tPrimaryB);
      check(r.status === 200 && r.body?.id === companyB && r.body?.name === `${marker}-B`, 'G3 company B\'s admin sees B, not A');
    }
    check((await call('GET', '', tGuard)).status === 403, 'G4 a guard token: 403 (requireAuth role gate)');
    check((await call('GET', '', null)).status === 401, 'G5 no token: 401');
    check((await call('GET', '', tInactiveA)).status === 403, 'G6 an inactive admin: 403 (requireAuth is_active re-read)');

    // ══════════════════════════════════════════════════════════════════════
    section('P  PATCH: authorization and request shape');
    const valid = { phone: '+1 (408) 555-0100' };
    {
      const r = await call('PATCH', '', tSecondA, valid);
      check(r.status === 403 && r.body?.code === 'NOT_PRIMARY_ADMIN', `P1 secondary admin: 403 NOT_PRIMARY_ADMIN although its JWT claims primary (got ${r.status} ${show(r.body)})`);
      const r2 = await call('PATCH', '', tSecondA, { name: 'x', bogus: 1 });
      check(r2.status === 403 && r2.body?.code === 'NOT_PRIMARY_ADMIN', 'P1b secondary with an invalid body still gets 403, not 400');
      check((await companyRow(companyA)).phone === null && (await auditRows(companyA)).length === 0, 'P1c nothing written');
    }
    {
      const r = await call('PATCH', '', tPrimaryA, { name: 'Renamed Co' });
      check(r.status === 400 && r.body?.code === 'NAME_NOT_EDITABLE', `P2 name: 400 NAME_NOT_EDITABLE (got ${r.status} ${show(r.body)})`);
      check(r.body?.error === 'Contact NetraOps to change your company name.', 'P2 copy is the decision-3a sentence');
      const r2 = await call('PATCH', '', tPrimaryA, { name: 'Renamed Co', ...valid });
      check(r2.status === 400 && r2.body?.code === 'NAME_NOT_EDITABLE', 'P3 name beside a valid field: still 400');
      const row = await companyRow(companyA);
      check(row.name === `${marker}-A` && row.phone === null, 'P3 neither the name nor the valid field was written');
    }
    {
      const r = await call('PATCH', '', tPrimaryA, { logo_url: 'https://x.test/a.png', is_primary: true, ...valid });
      check(r.status === 400 && r.body?.code === 'UNKNOWN_FIELDS' && show(r.body?.fields) === show(['is_primary', 'logo_url']),
        `P4 unknown keys: 400 UNKNOWN_FIELDS naming them (got ${r.status} ${show(r.body)})`);
    }
    {
      const r = await call('PATCH', '', tPrimaryA, ['phone']);
      check(r.status === 400 && r.body?.code === 'INVALID_BODY', `P5 a JSON array: 400 INVALID_BODY (got ${r.status} ${show(r.body)})`);
      const r2 = await call('PATCH', '', tPrimaryA, {});
      check(r2.status === 400 && r2.body?.code === 'NO_FIELDS', `P6 {}: 400 NO_FIELDS (got ${r2.status} ${show(r2.body)})`);
    }
    check((await call('PATCH', '', tGuard, valid)).status === 403, 'P7 a guard token: 403');
    check((await auditRows(companyA)).length === 0 && (await companyRow(companyA)).updated_at === null, 'P8 after every refusal: 0 audit rows, updated_at still null');

    // ══════════════════════════════════════════════════════════════════════
    section('V  PATCH: field validation (each case alone; nothing may be written)');
    const cases: Array<[string, unknown, string]> = [
      ['contact_email', 'not-an-email', 'INVALID_EMAIL'],
      ['contact_email', 'a@b', 'INVALID_EMAIL'],
      ['contact_email', 'a b@example.com', 'INVALID_EMAIL'],
      ['contact_email', `${'x'.repeat(244)}@example.com`, 'TOO_LONG'],
      ['contact_email', 42, 'INVALID_TYPE'],
      ['phone', '12345', 'TOO_SHORT'],
      ['phone', '1'.repeat(33), 'TOO_LONG'],
      ['phone', 'call 555-0100', 'INVALID_PHONE'],
      ['phone', '(--- ---)', 'INVALID_PHONE'],
      ['phone', { n: 1 }, 'INVALID_TYPE'],
      ['address', 'a'.repeat(501), 'TOO_LONG'],
      ['address', '😀'.repeat(501), 'TOO_LONG'],
      ['address', 'line one\u0000two', 'INVALID_CHARACTERS'],
      ['licence_number', 'L'.repeat(65), 'TOO_LONG'],
      ['licence_number', 'PPO\n123', 'INVALID_CHARACTERS'],
      ['website', 'example.com', 'INVALID_URL'],
      ['website', 'ftp://example.com', 'INVALID_URL'],
      ['website', 'javascript:alert(1)', 'INVALID_URL'],
      ['website', 'https://localhost', 'INVALID_URL'],
      ['website', 'https://user:pw@example.com', 'INVALID_URL'],
      ['website', 'https://exa mple.com', 'INVALID_URL'],
      ['website', `https://${'a'.repeat(248)}.com`, 'TOO_LONG'],
      ['website', true, 'INVALID_TYPE'],
    ];
    for (const [field, value, code] of cases) {
      const r = await call('PATCH', '', tPrimaryA, { [field]: value });
      const label = typeof value === 'string' && value.length > 24 ? `${value.slice(0, 20)}…(${value.length})` : show(value);
      check(r.status === 400 && r.body?.code === 'VALIDATION_FAILED' && r.body?.fields?.[field]?.code === code,
        `V ${field} = ${label}: ${code} (got ${r.status} ${r.body?.code} ${show(r.body?.fields)})`);
    }
    {
      const r = await call('PATCH', '', tPrimaryA, { contact_email: 'nope', website: 'nope', ...valid });
      check(r.status === 400 && show(Object.keys(r.body?.fields ?? {}).sort()) === show(['contact_email', 'website']),
        `V every invalid field reported at once, valid ones not listed (got ${show(r.body?.fields)})`);
      check(typeof r.body?.fields?.website?.message === 'string' && r.body.fields.website.message.length > 0, 'V each field error carries copy');
    }
    check((await auditRows(companyA)).length === 0 && (await companyRow(companyA)).phone === null, 'V nothing written by any invalid PATCH');

    // ══════════════════════════════════════════════════════════════════════
    section('W  PATCH: writes, audit, no-op, clearing');
    const first = {
      contact_email: '  office@starguard.test  ',
      phone: '+1 (408) 555-0100',
      address: '1 Main St\nSan Jose, CA 95112',
      licence_number: 'PPO 12345',
      website: 'https://example.com/about',
    };
    {
      const r = await call('PATCH', '', tPrimaryA, first);
      check(r.status === 200, `W1 primary: 200 (got ${r.status} ${show(r.body)})`);
      check(r.body?.contact_email === 'office@starguard.test', 'W1 values are trimmed');
      check(show(r.body?.changed) === show(['contact_email', 'phone', 'address', 'licence_number', 'website']), `W1 changed lists all five (got ${show(r.body?.changed)})`);
      check(r.body?.is_primary === true && r.body?.logo_url === null, 'W1 response is the profile shape (is_primary, logo_url)');
      const row = await companyRow(companyA);
      check(row.contact_email === 'office@starguard.test' && row.phone === first.phone && row.address === first.address
        && row.licence_number === first.licence_number && row.website === first.website, 'W1 the five columns hold the written values');
      check(row.name === `${marker}-A`, 'W1 name untouched');
      const audit = await auditRows(companyA);
      check(audit.length === 5, `W1 five audit rows (got ${audit.length})`);
      check(audit.every((a: any) => a.actor_admin_id === primaryA && a.old_value === null), 'W1 every row: actor = the primary, old_value null');
      check(show(audit.map((a: any) => [a.field, a.new_value]).sort()) === show(Object.entries({ ...first, contact_email: 'office@starguard.test' }).sort()),
        'W1 new_value per field = the stored value');
      check(audit.every((a: any) => ms(a.created_at) === ms(row.updated_at)) && !Number.isNaN(ms(row.updated_at)),
        'W1 audit rows and updated_at share one transaction timestamp');
    }
    {
      const before = await companyRow(companyA);
      const r = await call('PATCH', '', tPrimaryA, first);
      const after = await companyRow(companyA);
      check(r.status === 200 && show(r.body?.changed) === '[]', `W2 the same values again: 200, changed [] (got ${r.status} ${show(r.body?.changed)})`);
      check((await auditRows(companyA)).length === 5 && ms(after.updated_at) === ms(before.updated_at), 'W2 no new audit row, updated_at unchanged');
    }
    {
      const r = await call('PATCH', '', tPrimaryA, { phone: '408 555 0199' });
      const audit = await auditRows(companyA);
      const last = audit[audit.length - 1];
      check(r.status === 200 && show(r.body?.changed) === show(['phone']), 'W3 one field: changed [phone]');
      check(audit.length === 6 && last.field === 'phone' && last.old_value === first.phone && last.new_value === '408 555 0199',
        'W3 one audit row with the old and new phone');
      check((await companyRow(companyA)).website === first.website, 'W3 the other fields untouched');
    }
    {
      const r = await call('PATCH', '', tPrimaryA, { website: '   ', licence_number: null });
      const row = await companyRow(companyA);
      const audit = (await auditRows(companyA)).slice(-2);
      check(r.status === 200 && show(r.body?.changed) === show(['licence_number', 'website']), `W4 blank and null clear: changed [licence_number, website] (got ${show(r.body?.changed)})`);
      check(row.website === null && row.licence_number === null, 'W4 both stored as NULL (one representation of absence)');
      check(audit.every((a: any) => a.new_value === null) && show(audit.map((a: any) => a.old_value).sort()) === show([first.licence_number, first.website].sort()),
        'W4 audit rows carry the old values and new_value NULL');
    }
    {
      const emoji = '😀'.repeat(500);
      const r = await call('PATCH', '', tPrimaryA, { address: emoji });
      const len = (await q('SELECT char_length(address) AS n FROM companies WHERE id = $1', [companyA])).rows[0].n;
      check(r.status === 200 && len === 500, `W5 500 emoji (1,000 UTF-16 units) accepted and stored as 500 characters (got ${r.status}, ${len})`);
    }
    {
      const beforeA = await profileOf(companyA);
      const r = await call('PATCH', '', tPrimaryB, { phone: '650 555 0123' });
      check(r.status === 200 && r.body?.id === companyB, 'W6 company B\'s primary edits B');
      check(show(await profileOf(companyA)) === show(beforeA) && (await companyRow(companyB)).phone === '650 555 0123', 'W6 A untouched, B written');
      check((await auditRows(companyB)).length === 1 && (await auditRows(companyB))[0].actor_admin_id === primaryB, 'W6 B\'s audit row names B\'s primary');
    }
    check(presignedKeys.length === 0, `W7 no presign while no logo is set (got ${presignedKeys.length})`);

    // ══════════════════════════════════════════════════════════════════════
    section('E  error shape on every coded reply: { code, error: copy, message: copy }');
    {
      const coded = replies.filter((r) => r.status >= 400 && r.body && typeof r.body.code === 'string');
      const bad = coded.filter((r) => !(typeof r.body.error === 'string' && r.body.error === r.body.message
        && r.body.error !== r.body.code && !/^[A-Z0-9_]+$/.test(r.body.error)));
      check(coded.length >= 30, `E1 ${coded.length} coded error replies collected`);
      check(bad.length === 0, `E2 every one carries copy in error and message, never the enum (bad: ${show(bad.slice(0, 2))})`);
    }
    check(thrown.length === 0, `E3 no route threw (got ${thrown.length}: ${show(thrown.map(String))})`);
  } finally {
    if (KEEP) {
      console.log(`\n--keep: left companies ${companyIds.join(', ')} in place`);
    } else if (companyIds.length > 0) {
      await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
      const left = (await q(
        `SELECT (SELECT count(*) FROM companies WHERE name LIKE $1)::int
              + (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int
              + (SELECT count(*) FROM company_profile_audit WHERE company_id = ANY($2::uuid[]))::int AS n`,
        [`${marker}%`, companyIds])).rows[0].n;
      console.log(`\ncleanup: ${left} marker rows left (companies, admins, audit)`);
      if (left !== 0) failures += 1;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
