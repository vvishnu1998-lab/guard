/**
 * test-letterhead.ts — services/letterhead (index.ts, cache.ts) on a THROWAWAY
 * LOCAL Postgres replayed through schema_v82. Sentry and S3 are replaced in
 * require.cache before anything loads; the S3 stub is programmable per call
 * and records every fetch. Nothing reaches AWS.
 *
 * LOCAL DATABASES ONLY, as test-company-profile.ts: PGHOST 127.0.0.1 or
 * localhost, PGDATABASE ending in "test", no DATABASE_URL pointing elsewhere.
 * Seeds Star Guard's id (b7c7d32d-…) with FAKE profile data, a second empty
 * company, and a site and a guard for each; deletes them at the end.
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-letterhead.ts     (from apps/api)
 *
 *   K  LogoCache: TTLs (hit and miss), LRU by entries and by bytes, shared loads
 *   L  lookups through all three entry points; unknown and malformed ids
 *   M  every way a logo can be unavailable: logo null, a warning, never a throw
 *   C  the cache key follows logo_updated_at; concurrent lookups fetch once
 *   D  a database error: null, a warning, never a throw
 */
import Module from 'node:module';
import { pngCorruptAfterHeader, pngImage } from './image-fixtures';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const S3_HOST = 'test-bucket.s3.us-east-1.amazonaws.com';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  const url = process.env.DATABASE_URL;
  if (url) {
    let h = '';
    try { h = new URL(url).hostname; } catch { h = '(unparseable)'; }
    if (!LOCAL_HOSTS.has(h)) { console.error(`REFUSING: DATABASE_URL points at ${h}.`); process.exit(2); }
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

let failures = 0;
let passes = 0;

// A harness that stops before its last check must not pass: an await that never
// settles drains the event loop, and Node would then exit 0 having printed nothing.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)');
    process.exitCode = 1;
  }
});
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const show = (v: unknown): string => JSON.stringify(v);

async function main(): Promise<void> {
  refuseUnlessLocal();

  const sentry: Array<{ what: unknown; ctx: any }> = [];
  inject('../src/services/sentry', {
    Sentry: {
      captureMessage: (what: unknown, ctx: unknown) => { sentry.push({ what, ctx }); return 'evt'; },
      captureException: (what: unknown, ctx: unknown) => { sentry.push({ what, ctx }); return 'evt'; },
    },
    tagRequest: () => undefined,
  });

  class S3ObjectTooLargeError extends Error {}
  type Responder = (key: string) => Promise<Buffer>;
  const s3 = {
    fetches: [] as Array<{ key: string; opts: { maxBytes: number; timeoutMs: number } }>,
    respond: (async () => { throw new Error('no S3 responder set'); }) as Responder,
  };
  inject('../src/services/s3', {
    __esModule: true,
    S3ObjectTooLargeError,
    s3KeyFromPublicUrl: (url: string): string | null => {
      try {
        const u = new URL(url);
        if (u.hostname !== S3_HOST) return null;
        const key = u.pathname.replace(/^\//, '');
        return key.length > 0 ? key : null;
      } catch { return null; }
    },
    getS3ObjectBuffer: async (key: string, opts: { maxBytes: number; timeoutMs: number }) => {
      s3.fetches.push({ key, opts });
      return s3.respond(key);
    },
  });

  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  const lh = await import('../src/services/letterhead');
  const { LogoCache } = await import('../src/services/letterhead/cache');
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

  const marker = `lh-${Date.now().toString(36)}`;
  const ids = { companies: [] as string[], sites: [] as string[], guards: [] as string[] };

  try {
    // ══════════════════════════════════════════════════════════════════════
    section('K  LogoCache (injected clock)');
    {
      let t = 1_000;
      const c = new LogoCache({ maxEntries: 3, maxBytes: 10, hitTtlMs: 100, missTtlMs: 20, now: () => t });
      let loads = 0;
      const load = (v: Buffer | null) => async () => { loads += 1; return v; };
      const a = Buffer.from('aaaa');
      await c.get('a', load(a)); await c.get('a', load(a));
      check(loads === 1, `K1 a hit within the TTL does not load again (loads ${loads})`);
      t += 101; await c.get('a', load(a));
      check(loads === 2, `K2 after hitTtl the entry is gone and loads again (loads ${loads})`);
      loads = 0; await c.get('miss', load(null)); t += 19; await c.get('miss', load(null));
      check(loads === 1, 'K3 a miss is cached for missTtl');
      t += 2; await c.get('miss', load(null));
      check(loads === 2, 'K3b ...and only that long (shorter than a hit)');
      c.clear(); loads = 0;
      for (const k of ['k1', 'k2', 'k3']) await c.get(k, load(null));
      await c.get('k1', load(null));          // touch k1: k2 is now the oldest
      await c.get('k4', load(null));          // over maxEntries: k2 goes
      loads = 0; await c.get('k1', load(null)); await c.get('k3', load(null)); await c.get('k4', load(null));
      check(loads === 0, 'K4 LRU by entry count: the touched entry survives an eviction');
      await c.get('k2', load(null));
      check(loads === 1, 'K4b ...and the least recently used one was the one evicted');
      c.clear(); loads = 0;
      await c.get('b1', load(Buffer.alloc(6))); await c.get('b2', load(Buffer.alloc(6)));
      check(c.stats().bytes === 6 && c.stats().entries === 1, `K5 LRU by bytes: two 6-byte logos in a 10-byte cache keep one (got ${show(c.stats())})`);
      await c.get('big', load(Buffer.alloc(11))); await c.get('big', load(Buffer.alloc(11)));
      check(loads === 4 && c.stats().bytes === 6, 'K6 a value larger than the whole cache is returned but never stored');
      c.clear(); loads = 0;
      // Every load started is released, so a cache that stopped sharing loads
      // fails here on the count instead of leaving promises that never settle.
      const releases: Array<() => void> = [];
      const slow = () => new Promise<Buffer | null>((r) => { loads += 1; releases.push(() => r(a)); });
      const ps = [c.get('x', slow), c.get('x', slow), c.get('x', slow)];
      check(loads === 1 && c.stats().loading === 1, `K7 three concurrent misses share one load (loads started: ${loads})`);
      releases.forEach((release) => release());
      const got = await Promise.all(ps);
      check(loads === 1 && got.every((g) => g === a) && c.stats().loading === 0, 'K7b all three get its result; nothing left loading');
    }

    // ── fixtures ──────────────────────────────────────────────────────────
    const logoA = pngImage(400, 440);
    const logoB = pngImage(300, 300, { ctype: 2 });
    await q('DELETE FROM guards WHERE company_id = $1', [STAR_GUARD]);
    await q('DELETE FROM sites WHERE company_id = $1', [STAR_GUARD]);
    await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const keyA = `company-logos/${STAR_GUARD}/11111111-1111-4111-8111-111111111111.png`;
    await q(`INSERT INTO companies (id, name, contact_email, phone, address, licence_number, website, logo_url, logo_updated_at)
             VALUES ($1, 'Star Guard', '  dispatch@starguard.example ', '+1 (408) 555-0142', $2, ' PPO 120456', 'https://www.starguard.example/', $3, now())`,
      [STAR_GUARD, '1200 Example Avenue, Suite 300\nSan Jose, CA 95110', `https://${S3_HOST}/${keyA}`]);
    ids.companies.push(STAR_GUARD);
    const empty = (await q('INSERT INTO companies (name) VALUES ($1) RETURNING id', [`${marker}-empty`])).rows[0].id;
    ids.companies.push(empty);
    const mkSite = async (co: string) => {
      const id = (await q(`INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1 Test St', '2026-01-01') RETURNING id`,
        [co, `${marker}-site`])).rows[0].id;
      ids.sites.push(id); return id;
    };
    const mkGuard = async (co: string, n: number) => {
      const id = (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
        [co, `${marker} guard ${n}`, `${marker}-${n}@test.invalid`, `GRD99${n}${n}`])).rows[0].id;
      ids.guards.push(id); return id;
    };
    const siteA = await mkSite(STAR_GUARD);
    const guardA = await mkGuard(STAR_GUARD, 1);
    const siteE = await mkSite(empty);
    const guardE = await mkGuard(empty, 2);
    const reset = () => { lh.logoCache.clear(); s3.fetches.length = 0; sentry.length = 0; };

    // ══════════════════════════════════════════════════════════════════════
    section('L  lookups');
    reset();
    s3.respond = async () => logoA;
    const expected = {
      companyName: 'Star Guard',
      contactEmail: 'dispatch@starguard.example',
      phone: '+1 (408) 555-0142',
      address: '1200 Example Avenue, Suite 300\nSan Jose, CA 95110',
      licenceNumber: 'PPO 120456',
      website: 'https://www.starguard.example/',
    };
    const byCompany = await lh.letterheadForCompany(STAR_GUARD);
    const textOf = (l: any) => l && Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'logo'));
    check(show(textOf(byCompany)) === show(expected), `L1 by company: every text field, trimmed (got ${show(textOf(byCompany))})`);
    check(byCompany?.logo instanceof Buffer && byCompany.logo.equals(logoA), 'L1 the logo is the stored object\'s bytes');
    check(s3.fetches.length === 1 && s3.fetches[0].key === keyA && s3.fetches[0].opts.maxBytes === 2 * 1024 * 1024 && s3.fetches[0].opts.timeoutMs === 5000,
      `L1 one fetch: the key parsed from logo_url, capped at 2 MiB, 5 s timeout (got ${show(s3.fetches)})`);
    const bySite = await lh.letterheadForSite(siteA);
    const byGuard = await lh.letterheadForGuard(guardA);
    check(show(textOf(bySite)) === show(expected) && bySite?.logo?.equals(logoA) === true, 'L2 by site: the same letterhead');
    check(show(textOf(byGuard)) === show(expected) && byGuard?.logo?.equals(logoA) === true, 'L3 by guard: the same letterhead');
    check(s3.fetches.length === 1, `L2/L3 served from the cache: still one fetch (got ${s3.fetches.length})`);
    const ghost = '00000000-0000-4000-8000-000000000000';
    const unknown = await Promise.all([lh.letterheadForCompany(ghost), lh.letterheadForSite(ghost), lh.letterheadForGuard(ghost)]);
    check(unknown.every((u) => u === null), 'L4 an id that matches nothing: null from all three (today\'s header)');
    const malformed = await Promise.all([lh.letterheadForCompany('not-a-uuid'), lh.letterheadForSite(''), lh.letterheadForGuard(undefined as unknown as string),
      lh.letterheadForCompany(`${STAR_GUARD}' OR '1'='1`)]);
    check(malformed.every((u) => u === null) && sentry.length === 0, `L5 malformed ids: null, without querying and without a warning (sentry ${sentry.length})`);
    {
      reset();
      const viaE = await Promise.all([lh.letterheadForCompany(empty), lh.letterheadForSite(siteE), lh.letterheadForGuard(guardE)]);
      check(viaE.every((l) => l !== null && l.companyName === `${marker}-empty` && l.contactEmail === null && l.phone === null
        && l.address === null && l.licenceNumber === null && l.website === null && l.logo === null),
        'L6 an empty profile: the name, every other field null, logo null (all three entry points)');
      check(s3.fetches.length === 0 && sentry.length === 0, 'L6 no logo_url: no fetch, no warning');
      await q(`UPDATE companies SET phone = '   ', website = '' WHERE id = $1`, [empty]);
      const blanks = await lh.letterheadForCompany(empty);
      check(blanks?.phone === null && blanks?.website === null, 'L7 blank strings come back as null');
    }

    // ══════════════════════════════════════════════════════════════════════
    section('M  a logo that is unavailable: logo null, a warning, never a throw');
    const failCase = async (label: string, respond: Responder, reason: string, logoUrl = `https://${S3_HOST}/${keyA}`, expectFetch = true) => {
      reset();
      await q('UPDATE companies SET logo_url = $2, logo_updated_at = now() WHERE id = $1', [STAR_GUARD, logoUrl]);
      s3.respond = respond;
      let threw: unknown = null;
      let got: any = null;
      try { got = await lh.letterheadForCompany(STAR_GUARD); } catch (e) { threw = e; }
      const warn = sentry.filter((s) => s.what === 'letterhead_logo_unavailable');
      check(threw === null && got !== null && got.logo === null && got.companyName === 'Star Guard' && got.licenceNumber === 'PPO 120456',
        `${label}: the letterhead still comes back, logo null (threw ${String(threw)})`);
      check(warn.length === 1 && warn[0].ctx?.level === 'warning' && warn[0].ctx?.tags?.reason === reason && warn[0].ctx?.extra?.company_id === STAR_GUARD,
        `${label}: one Sentry warning, reason ${reason} (got ${show(warn.map((w) => w.ctx?.tags))})`);
      check(s3.fetches.length === (expectFetch ? 1 : 0), `${label}: ${expectFetch ? 'one fetch' : 'no fetch'} (got ${s3.fetches.length})`);
    };
    await failCase('M1 object missing (NoSuchKey)', async () => { throw Object.assign(new Error('The specified key does not exist.'), { code: 'NoSuchKey' }); }, 'missing');
    {
      // Negative caching: the same logo_updated_at again does not fetch or warn again.
      const fetchesBefore = s3.fetches.length;
      const again = await lh.letterheadForCompany(STAR_GUARD);
      check(again?.logo === null && s3.fetches.length === fetchesBefore && sentry.length === 1, 'M1b asked again: the miss is cached, no second fetch, no second warning');
    }
    await failCase('M2 valid header, body does not decode (N167)', async () => pngCorruptAfterHeader(512, 512), 'does_not_decode');
    await failCase('M3 larger than 2 MiB', async () => { throw new S3ObjectTooLargeError('too large'); }, 'too_large');
    await failCase('M4 S3 does not answer in time', async () => { throw Object.assign(new Error('Request aborted by user'), { code: 'RequestAbortedError' }); }, 'timeout');
    await failCase('M5 any other S3 error (AccessDenied)', async () => { throw Object.assign(new Error('Access Denied'), { code: 'AccessDenied' }); }, 's3_error');
    await failCase('M6 logo_url on another host', async () => logoA, 'not_our_bucket', 'https://evil.example/company-logos/x.png', false);
    await failCase('M7 a JPEG that is not one', async () => Buffer.from('\xff\xd8\xff\xe0 not really', 'latin1'), 'does_not_decode');

    // ══════════════════════════════════════════════════════════════════════
    section('C  the cache key follows logo_updated_at');
    {
      reset();
      await q('UPDATE companies SET logo_url = $2, logo_updated_at = now() WHERE id = $1', [STAR_GUARD, `https://${S3_HOST}/${keyA}`]);
      s3.respond = async () => logoA;
      await lh.letterheadForCompany(STAR_GUARD);
      await lh.letterheadForSite(siteA);
      check(s3.fetches.length === 1, 'C1 the same logo_updated_at: fetched once');
      const keyB = `company-logos/${STAR_GUARD}/22222222-2222-4222-8222-222222222222.png`;
      await q('UPDATE companies SET logo_url = $2, logo_updated_at = now() WHERE id = $1', [STAR_GUARD, `https://${S3_HOST}/${keyB}`]);
      s3.respond = async (key) => (key === keyB ? logoB : logoA);
      const after = await lh.letterheadForGuard(guardA);
      check(s3.fetches.length === 2 && s3.fetches[1].key === keyB && after?.logo?.equals(logoB) === true,
        'C2 a new upload (new logo_updated_at): a miss, the new object fetched, the new bytes returned');
      await q('UPDATE companies SET logo_url = NULL, logo_updated_at = now() WHERE id = $1', [STAR_GUARD]);
      const removed = await lh.letterheadForCompany(STAR_GUARD);
      check(removed?.logo === null && s3.fetches.length === 2, 'C3 logo removed: logo null at once, no fetch');
      await q('UPDATE companies SET logo_url = $2, logo_updated_at = now() WHERE id = $1', [STAR_GUARD, `https://${S3_HOST}/${keyA}`]);
      reset();
      s3.respond = async () => { await new Promise((r) => setTimeout(r, 50)); return logoA; };
      const burst = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        [lh.letterheadForCompany, lh.letterheadForSite, lh.letterheadForGuard][i % 3]([STAR_GUARD, siteA, guardA][i % 3])));
      check(s3.fetches.length === 1 && burst.every((b) => b?.logo?.equals(logoA) === true), `C4 six concurrent lookups: one fetch (got ${s3.fetches.length})`);
    }

    // ══════════════════════════════════════════════════════════════════════
    section('D  a database error');
    {
      reset();
      const realQuery = pool.query.bind(pool);
      pool.query = async () => { throw new Error('connection terminated unexpectedly'); };
      let threw: unknown = null;
      let got: unknown = 'unset';
      try { got = await lh.letterheadForSite(siteA); } catch (e) { threw = e; } finally { pool.query = realQuery; }
      const warn = sentry.filter((s) => s.what === 'letterhead_lookup_failed');
      check(threw === null && got === null, `D1 the lookup fails: null (today's header), no throw (got ${show(got)}, threw ${String(threw)})`);
      check(warn.length === 1 && warn[0].ctx?.level === 'warning' && warn[0].ctx?.tags?.via === 'site', `D1 one Sentry warning, via site (got ${show(warn.map((w) => w.ctx?.tags))})`);
    }
  } finally {
    if (ids.guards.length) await q('DELETE FROM guards WHERE id = ANY($1::uuid[])', [ids.guards]);
    if (ids.sites.length) await q('DELETE FROM sites WHERE id = ANY($1::uuid[])', [ids.sites]);
    if (ids.companies.length) await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [ids.companies]);
    const left = (await q(`SELECT (SELECT count(*) FROM companies WHERE id = ANY($1::uuid[]))::int
                                + (SELECT count(*) FROM sites WHERE name LIKE $2)::int
                                + (SELECT count(*) FROM guards WHERE email LIKE $2)::int AS n`, [ids.companies, `${marker}%`])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
    await pool.end();
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
