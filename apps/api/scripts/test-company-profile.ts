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
 * Images: a refusal that happens BEFORE the decode check (role, field, header,
 * dimensions, size) is sent a header-only fixture (test-image-dimensions.ts);
 * anything that reaches the decode check is sent a real image built in code
 * (image-fixtures.ts), because a header-only file no longer decodes.
 *
 * Checks never stop at the first failure; the exit code is the verdict.
 */
import Module from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { jpegHeader, pngHeader } from './test-image-dimensions';
import { jpegCorruptAfterHeader, jpegImage, jpegTruncated, pngCorruptAfterHeader, pngImage, pngPadded } from './image-fixtures';
import { readImageDimensions } from '../src/services/imageDimensions';

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

  const sentry: Array<{ kind: 'message' | 'exception'; what: unknown; ctx: any }> = [];
  inject('../src/services/sentry', {
    Sentry: {
      captureMessage: (what: unknown, ctx: unknown) => { sentry.push({ kind: 'message', what, ctx }); return 'evt'; },
      captureException: (what: unknown, ctx: unknown) => { sentry.push({ kind: 'exception', what, ctx }); return 'evt'; },
      addBreadcrumb: () => undefined,
      withScope: (fn: (s: unknown) => void) => fn({ setTag: () => undefined, setExtra: () => undefined }),
    },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));

  // S3, recorded. A delete also records how many companies rows pointed at
  // the object AT THAT MOMENT: zero proves the delete ran after the commit
  // (or after a rollback), never while the row still referenced it.
  const S3_HOST = 'test-bucket.s3.us-east-1.amazonaws.com';
  const s3 = {
    puts: [] as Array<{ key: string; contentType: string; bytes: number; url: string }>,
    deletes: [] as Array<{ url: string; referencedAtDelete: number }>,
    putFails: false,
    deleteOutcome: { status: 'deleted' } as Record<string, unknown>,
  };
  let poolRef: any = null;
  const presignedKeys: string[] = [];
  inject('../src/services/s3', stubModule('s3', {
    urlOrPresign: async (stored: string | null | undefined) => {
      if (!stored) return null;
      const key = stored.replace(/^https?:\/\/[^/]+\//, '');
      presignedKeys.push(key);
      return `https://signed.test/${key}?X-Amz-Expires=900`;
    },
    uploadBufferToS3: async (key: string, buf: Buffer, contentType: string) => {
      if (s3.putFails) throw new Error('stub: PutObject AccessDenied');
      const url = `https://${S3_HOST}/${key}`;
      s3.puts.push({ key, contentType, bytes: buf.length, url });
      return url;
    },
    deleteS3Object: async (url: string) => {
      const n = (await poolRef.query('SELECT count(*)::int AS n FROM companies WHERE logo_url = $1', [url])).rows[0].n;
      s3.deletes.push({ url, referencedAtDelete: n });
      return s3.deleteOutcome;
    },
  }));

  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) {
    console.error('REFUSING: the app pool carries a connection string; unset DATABASE_URL.');
    process.exit(2);
  }
  poolRef = pool;
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
    const MAX = 2 * 1024 * 1024;   // LOGO_MAX_BYTES, written out independently
    const pad = (b: Buffer, size: number): Buffer => Buffer.concat([b, Buffer.alloc(size - b.length)]);
    function form(bytes: Buffer, opts: { field?: string; filename?: string; type?: string; twice?: boolean } = {}): FormData {
      const f = new FormData();
      const blob = new Blob([new Uint8Array(bytes)], { type: opts.type ?? 'image/png' });
      f.append(opts.field ?? 'file', blob, opts.filename ?? 'logo.png');
      if (opts.twice) f.append(opts.field ?? 'file', blob, 'second.png');
      return f;
    }
    const logoAudit = async (id: string) => (await auditRows(id)).filter((a: any) => a.field === 'logo_url');
    const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

    section('L  POST /logo: every refusal happens before S3 and writes nothing');
    {
      const r = await call('POST', '/logo', tSecondA, form(pngHeader(512, 512)));
      check(r.status === 403 && r.body?.code === 'NOT_PRIMARY_ADMIN', `L1 secondary admin: 403 NOT_PRIMARY_ADMIN (got ${r.status} ${show(r.body)})`);
    }
    {
      const f = new FormData();
      f.append('note', 'no file here');
      const r = await call('POST', '/logo', tPrimaryA, f);
      check(r.status === 400 && r.body?.code === 'LOGO_FILE_REQUIRED', `L2 multipart without a file: 400 LOGO_FILE_REQUIRED (got ${r.status} ${show(r.body)})`);
      const r2 = await call('POST', '/logo', tPrimaryA, { file: 'not multipart' });
      check(r2.status === 400 && r2.body?.code === 'LOGO_FILE_REQUIRED', `L2b a JSON body: 400 LOGO_FILE_REQUIRED (got ${r2.status} ${show(r2.body)})`);
    }
    {
      const r = await call('POST', '/logo', tPrimaryA, form(pngHeader(512, 512), { field: 'logo' }));
      check(r.status === 400 && r.body?.code === 'INVALID_UPLOAD', `L3 file under the wrong field name: 400 INVALID_UPLOAD (got ${r.status} ${show(r.body)})`);
      const r2 = await call('POST', '/logo', tPrimaryA, form(pngHeader(512, 512), { twice: true }));
      check(r2.status === 400 && r2.body?.code === 'INVALID_UPLOAD', `L3b two files: 400 INVALID_UPLOAD (got ${r2.status} ${show(r2.body)})`);
    }
    {
      const gif = Buffer.from('GIF89a\x00\x02\x00\x02\x00\x00', 'latin1');
      const r = await call('POST', '/logo', tPrimaryA, form(gif, { type: 'image/png', filename: 'logo.png' }));
      check(r.status === 400 && r.body?.code === 'LOGO_UNSUPPORTED_TYPE', `L4 GIF bytes named logo.png, declared image/png: 400 LOGO_UNSUPPORTED_TYPE (got ${r.status} ${show(r.body)})`);
      const webp = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.alloc(32)]);
      const r2 = await call('POST', '/logo', tPrimaryA, form(webp, { type: 'image/webp', filename: 'logo.webp' }));
      check(r2.status === 400 && r2.body?.code === 'LOGO_UNSUPPORTED_TYPE', `L5 WebP: 400 LOGO_UNSUPPORTED_TYPE (got ${r2.status} ${show(r2.body)})`);
      const r3 = await call('POST', '/logo', tPrimaryA, form(pngHeader(512, 512).subarray(0, 20)));
      check(r3.status === 400 && r3.body?.code === 'LOGO_UNREADABLE', `L6 PNG with a truncated header: 400 LOGO_UNREADABLE (got ${r3.status} ${show(r3.body)})`);
    }
    for (const [label, bytes, w, h] of [
      ['PNG 255 × 255', pngHeader(255, 255), 255, 255],
      ['PNG 2049 × 100', pngHeader(2049, 100), 2049, 100],
      ['JPEG 200 × 150', jpegHeader(200, 150), 200, 150],
      ['JPEG 4000 × 10', jpegHeader(4000, 10), 4000, 10],
    ] as Array<[string, Buffer, number, number]>) {
      const r = await call('POST', '/logo', tPrimaryA, form(bytes, { type: label.startsWith('PNG') ? 'image/png' : 'image/jpeg' }));
      check(r.status === 400 && r.body?.code === 'LOGO_DIMENSIONS_OUT_OF_RANGE' && r.body?.width === w && r.body?.height === h,
        `L7 ${label}: 400 LOGO_DIMENSIONS_OUT_OF_RANGE with the measured size (got ${r.status} ${r.body?.code} ${r.body?.width}×${r.body?.height})`);
    }
    {
      const r = await call('POST', '/logo', tPrimaryA, form(pad(pngHeader(512, 512), MAX + 1)));
      check(r.status === 413 && r.body?.code === 'LOGO_TOO_LARGE', `L8 2 MiB + 1 byte: 413 LOGO_TOO_LARGE (got ${r.status} ${show(r.body)})`);
    }
    for (const [label, bytes, type] of [
      ['PNG 512 × 512: valid IHDR, garbage image data (N167)', pngCorruptAfterHeader(512, 512), 'image/png'],
      ['PNG 512 × 512: image data 10 rows short', pngImage(512, 512, { ctype: 2, shortRows: 10 }), 'image/png'],
      ['JPEG 640 × 480: frame header, then garbage', jpegCorruptAfterHeader(640, 480), 'image/jpeg'],
      ['JPEG 640 × 480: EOI cut off', jpegTruncated(640, 480), 'image/jpeg'],
    ] as Array<[string, Buffer, string]>) {
      // The header reader must accept the file, or the OLD check would be the one refusing it.
      const dims = readImageDimensions(bytes);
      const r = await call('POST', '/logo', tPrimaryA, form(bytes, { type }));
      check(dims !== null && Math.max(dims.width, dims.height) >= 256 && r.status === 400 && r.body?.code === 'LOGO_UNREADABLE'
        && r.body?.error === 'That image could not be read. Export it again as PNG or JPEG and retry.',
        `L10 ${label}: the header passes (${dims ? `${dims.width}×${dims.height}` : 'NO HEADER'}), the body does not decode: 400 LOGO_UNREADABLE (got ${r.status} ${show(r.body)})`);
    }
    {
      const row = await companyRow(companyA);
      check(s3.puts.length === 0 && s3.deletes.length === 0, `L9 no S3 call for any refusal (puts ${s3.puts.length}, deletes ${s3.deletes.length})`);
      check(row.logo_url === null && row.logo_updated_at === null && (await logoAudit(companyA)).length === 0, 'L9 logo_url, logo_updated_at and the audit untouched');
    }

    section('U  POST /logo: upload, replace, and the failure orderings');
    let url1 = '';
    let url2 = '';
    let url3 = '';
    {
      const before = await companyRow(companyA);
      const r = await call('POST', '/logo', tPrimaryA, form(pngPadded(256, 256, MAX), { type: 'application/octet-stream', filename: 'logo.bin' }));
      check(r.status === 200, `U1 a real PNG 256 × 256 padded (private ancillary chunk) to exactly 2 MiB (both bounds inclusive), declared octet-stream: 200 (got ${r.status} ${r.body?.code ?? ''})`);
      const put = s3.puts[0];
      check(s3.puts.length === 1 && new RegExp(`^company-logos/${companyA}/${UUID}\\.png$`).test(put?.key ?? ''), `U1 one PUT at company-logos/{company_id}/{uuid}.png (got ${show(put?.key)})`);
      check(put?.contentType === 'image/png' && put?.bytes === MAX, `U1 content type from the magic bytes, all ${MAX} bytes sent (got ${put?.contentType}, ${put?.bytes})`);
      url1 = put?.url ?? '';
      const row = await companyRow(companyA);
      check(row.logo_url === url1 && url1.startsWith(`https://${S3_HOST}/company-logos/`), 'U1 logo_url stores the FULL URL, not a bare key');
      check(!Number.isNaN(ms(row.logo_updated_at)) && ms(row.updated_at) === ms(row.logo_updated_at) && ms(row.updated_at) > ms(before.updated_at),
        'U1 logo_updated_at set, updated_at moved with it');
      check(r.body?.logo_url === `https://signed.test/${put?.key}?X-Amz-Expires=900`, 'U1 the response carries a presigned URL, never the stored one');
      const audit = await logoAudit(companyA);
      check(audit.length === 1 && audit[0].old_value === null && audit[0].new_value === url1 && audit[0].actor_admin_id === primaryA,
        'U1 one audit row: logo_url, old NULL, new = the full URL, actor = the primary');
      check(s3.deletes.length === 0, 'U1 nothing deleted on a first upload');
    }
    {
      const before = await companyRow(companyA);
      const r = await call('POST', '/logo', tPrimaryA, form(jpegImage(2048, 1024), { type: 'image/jpeg', filename: 'logo.jpg' }));
      const put = s3.puts[1];
      url2 = put?.url ?? '';
      check(r.status === 200 && new RegExp(`^company-logos/${companyA}/${UUID}\\.jpg$`).test(put?.key ?? '') && put?.contentType === 'image/jpeg',
        `U2 replace with JPEG 2048 × 1024 (upper bound): 200, .jpg key, image/jpeg (got ${r.status} ${show(put)})`);
      check((await companyRow(companyA)).logo_url === url2, 'U2 logo_url now the new object');
      check(s3.deletes.length === 1 && s3.deletes[0].url === url1, `U2 the previous object deleted (got ${show(s3.deletes)})`);
      check(s3.deletes[0]?.referencedAtDelete === 0, 'U2 ...and only after the commit: no row pointed at it when the delete ran');
      const audit = await logoAudit(companyA);
      check(audit.length === 2 && audit[1].old_value === url1 && audit[1].new_value === url2, 'U2 audit row old = previous URL, new = new URL');
      check(ms((await companyRow(companyA)).logo_updated_at) > ms(before.logo_updated_at), 'U2 logo_updated_at advanced');
    }
    {
      s3.deleteOutcome = { status: 'failed', detail: 'stub: DeleteObject AccessDenied' };
      const sentryBefore = sentry.length;
      const r = await call('POST', '/logo', tPrimaryA, form(pngImage(512, 512)));
      s3.deleteOutcome = { status: 'deleted' };
      url3 = s3.puts[2]?.url ?? '';
      check(r.status === 200 && (await companyRow(companyA)).logo_url === url3, `U3 previous-object delete FAILS: the request still succeeds (got ${r.status})`);
      check(s3.deletes.length === 2 && s3.deletes[1].url === url2, 'U3 the delete of the previous object was attempted');
      const ev = sentry.slice(sentryBefore);
      check(ev.length === 1 && ev[0].kind === 'message' && ev[0].what === 'company_logo_delete_failed' && ev[0].ctx?.tags?.reason === 'replaced',
        `U3 reported to Sentry as company_logo_delete_failed, reason replaced (got ${show(ev.map((e) => [e.kind, e.what, e.ctx?.tags]))})`);
    }
    {
      s3.putFails = true;
      const auditBefore = (await logoAudit(companyA)).length;
      const sentryBefore = sentry.length;
      const deletesBefore = s3.deletes.length;
      const r = await call('POST', '/logo', tPrimaryA, form(pngImage(512, 512)));
      s3.putFails = false;
      check(r.status === 502 && r.body?.code === 'LOGO_UPLOAD_FAILED', `U4 S3 PUT fails: 502 LOGO_UPLOAD_FAILED (got ${r.status} ${show(r.body)})`);
      check((await companyRow(companyA)).logo_url === url3 && (await logoAudit(companyA)).length === auditBefore && s3.deletes.length === deletesBefore,
        'U4 nothing written, nothing deleted');
      const ev = sentry.slice(sentryBefore);
      check(ev.length === 1 && ev[0].kind === 'exception' && ev[0].ctx?.tags?.step === 'logo_put', 'U4 the PUT failure is reported to Sentry');
    }
    {
      // The transaction fails AFTER the PUT: the audit insert hits a missing table.
      const thrownBefore = thrown.length;
      const putsBefore = s3.puts.length;
      await q('ALTER TABLE company_profile_audit RENAME TO company_profile_audit_off');
      let r: Reply;
      try {
        r = await call('POST', '/logo', tPrimaryA, form(pngImage(512, 512)));
      } finally {
        await q('ALTER TABLE company_profile_audit_off RENAME TO company_profile_audit');
      }
      const orphan = s3.puts[putsBefore]?.url;
      check(r.status === 500 && thrown.length === thrownBefore + 1, `U5 DB failure after the PUT: 500 through the error handler (got ${r.status})`);
      check((await companyRow(companyA)).logo_url === url3, 'U5 the row still points at the previous logo (rolled back)');
      const del = s3.deletes[s3.deletes.length - 1];
      check(del?.url === orphan && del?.referencedAtDelete === 0, 'U5 the just-uploaded object is deleted again; the live one is not');
    }
    {
      const r = await call('POST', '/logo', tPrimaryB, form(pngImage(300, 300)));
      const put = s3.puts[s3.puts.length - 1];
      check(r.status === 200 && put?.key.startsWith(`company-logos/${companyB}/`), `U6 company B's primary: key under B's id (got ${put?.key})`);
      check((await companyRow(companyA)).logo_url === url3, 'U6 A\'s logo untouched');
    }

    section('D  DELETE /logo');
    {
      const deletesBefore = s3.deletes.length;
      const r = await call('DELETE', '/logo', tSecondA);
      check(r.status === 403 && r.body?.code === 'NOT_PRIMARY_ADMIN', `D1 secondary admin: 403 NOT_PRIMARY_ADMIN (got ${r.status} ${show(r.body)})`);
      check((await companyRow(companyA)).logo_url === url3 && s3.deletes.length === deletesBefore, 'D1 nothing changed, nothing deleted');
      check((await call('DELETE', '/logo', tGuard)).status === 403, 'D2 a guard token: 403');
    }
    {
      const before = await companyRow(companyA);
      const auditBefore = (await logoAudit(companyA)).length;
      const r = await call('DELETE', '/logo', tPrimaryA);
      const row = await companyRow(companyA);
      check(r.status === 200 && r.body?.removed === true && r.body?.logo_url === null, `D3 primary: 200, removed true, logo_url null (got ${r.status} ${show(r.body?.removed)})`);
      check(row.logo_url === null && ms(row.logo_updated_at) > ms(before.logo_updated_at), 'D3 logo_url NULL in the DB, logo_updated_at advanced');
      const audit = await logoAudit(companyA);
      check(audit.length === auditBefore + 1 && audit[audit.length - 1].old_value === url3 && audit[audit.length - 1].new_value === null,
        'D3 audit row old = the URL, new NULL');
      const del = s3.deletes[s3.deletes.length - 1];
      check(del?.url === url3 && del?.referencedAtDelete === 0, 'D3 the object deleted after the commit');
    }
    {
      const deletesBefore = s3.deletes.length;
      const auditBefore = (await logoAudit(companyA)).length;
      const r = await call('DELETE', '/logo', tPrimaryA);
      check(r.status === 200 && r.body?.removed === false, `D4 again: 200, removed false (got ${r.status} ${show(r.body?.removed)})`);
      check(s3.deletes.length === deletesBefore && (await logoAudit(companyA)).length === auditBefore, 'D4 no delete, no audit row');
    }

    // ══════════════════════════════════════════════════════════════════════
    section('E  error shape on every coded reply: { code, error: copy, message: copy }');
    {
      const coded = replies.filter((r) => r.status >= 400 && r.body && typeof r.body.code === 'string');
      const bad = coded.filter((r) => !(typeof r.body.error === 'string' && r.body.error === r.body.message
        && r.body.error !== r.body.code && !/^[A-Z0-9_]+$/.test(r.body.error)));
      check(coded.length >= 30, `E1 ${coded.length} coded error replies collected`);
      check(bad.length === 0, `E2 every one carries copy in error and message, never the enum (bad: ${show(bad.slice(0, 2))})`);
    }
    check(thrown.length === 1 && String(thrown[0]).includes('company_profile_audit'),
      `E3 the only throw is U5's deliberate one (got ${thrown.length}: ${show(thrown.map(String))})`);
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
