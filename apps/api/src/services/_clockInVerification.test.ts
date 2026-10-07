/**
 * Idempotent clock-in verification (NETRAOPS-API-X).
 *
 * Standalone node:assert, same shape as _mockLocation.test.ts — no test
 * framework in this repo. Needs a THROWAWAY local Postgres database; the
 * connection string is hardcoded to localhost below and the script refuses
 * any other host. It never reads .env. Run with:
 *   createdb netraops_civ_test
 *   npx ts-node --compiler-options '{"module":"commonjs"}' \
 *     apps/api/src/services/_clockInVerification.test.ts
 *   dropdb netraops_civ_test
 *
 * A fake query client would prove only this file's idea of ON CONFLICT; the
 * point is Postgres's own behaviour against the real UNIQUE (shift_session_id)
 * constraint, so the table below mirrors production's columns and the
 * constraint name 23505 reported in Sentry.
 *
 * Two layers:
 *   - helper: writeClockInVerification directly, including the 'conflict'
 *     backstop, which the route cannot reach because its ownership check
 *     404s first;
 *   - route:  the real express router, with db/pool's query/connect pointed
 *     at the local database, proving the wire contract (201 → 200 same body,
 *     other guard → 404).
 */
import assert from 'node:assert';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool as appPool } from '../db/pool';
import locationsRoutes from '../routes/locations';
import { writeClockInVerification, ClockInVerificationInput } from './clockInVerification';

const CONN = 'postgresql://localhost:5432/netraops_civ_test';
if (new URL(CONN).hostname !== 'localhost') throw new Error('refusing a non-local database');

const db = new Pool({ connectionString: CONN });
// Every app module imports the same pool object; point its two entry points
// at the local database before any request runs.
(appPool as any).query   = db.query.bind(db);
(appPool as any).connect = db.connect.bind(db);

process.env.JWT_SECRET = 'civ-test-secret-not-a-real-secret';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function schema() {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    DROP TABLE IF EXISTS clock_in_verifications, shift_sessions, site_geofence, sites, guards CASCADE;
    CREATE TABLE guards (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      company_id UUID NOT NULL DEFAULT uuid_generate_v4(),
      is_active BOOLEAN NOT NULL DEFAULT true,
      tokens_not_before TIMESTAMPTZ
    );
    CREATE TABLE sites (id UUID PRIMARY KEY DEFAULT uuid_generate_v4());
    -- Empty: validateAtSite treats a site with no fence row as allowed.
    CREATE TABLE site_geofence (
      site_id UUID, polygon_coordinates JSONB,
      center_lat DOUBLE PRECISION, center_lng DOUBLE PRECISION, radius_meters DOUBLE PRECISION
    );
    CREATE TABLE shift_sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      guard_id UUID NOT NULL REFERENCES guards(id),
      site_id UUID NOT NULL REFERENCES sites(id),
      clocked_out_at TIMESTAMPTZ,
      legal_hold BOOLEAN NOT NULL DEFAULT false,
      legal_hold_at TIMESTAMPTZ
    );
    -- Production columns and constraints, probed 2026-09-24.
    CREATE TABLE clock_in_verifications (
      id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      shift_session_id   UUID NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
      guard_id           UUID NOT NULL REFERENCES guards(id),
      site_id            UUID NOT NULL REFERENCES sites(id),
      selfie_url         VARCHAR(1000),
      site_photo_url     VARCHAR(1000),
      verified_lat       DOUBLE PRECISION NOT NULL,
      verified_lng       DOUBLE PRECISION NOT NULL,
      is_within_geofence BOOLEAN NOT NULL,
      verified_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accuracy_meters    DOUBLE PRECISION,
      location_mocked    BOOLEAN,
      fix_age_ms         INTEGER,
      legal_hold         BOOLEAN NOT NULL DEFAULT false,
      legal_hold_at      TIMESTAMPTZ,
      CONSTRAINT clock_in_verifications_shift_session_id_key UNIQUE (shift_session_id)
    );
  `);
}

async function guard(): Promise<string> {
  return (await db.query(`INSERT INTO guards DEFAULT VALUES RETURNING id`)).rows[0].id;
}
async function session(guardId: string, legalHold = false): Promise<string> {
  const site = (await db.query(`INSERT INTO sites DEFAULT VALUES RETURNING id`)).rows[0].id;
  return (await db.query(
    `INSERT INTO shift_sessions (guard_id, site_id, legal_hold, legal_hold_at)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() END) RETURNING id`,
    [guardId, site, legalHold],
  )).rows[0].id;
}
async function rowsFor(sessionId: string) {
  return (await db.query(`SELECT * FROM clock_in_verifications WHERE shift_session_id = $1`, [sessionId])).rows;
}
function input(sessionId: string, selfie: string): ClockInVerificationInput {
  return {
    shiftSessionId: sessionId, selfieUrl: selfie, sitePhotoUrl: null,
    verifiedLat: 37.0, verifiedLng: -122.0, accuracyMeters: 9.5, locationMocked: null, fixAgeMs: 1604,
  };
}

async function helperTests() {
  console.log('helper: writeClockInVerification\n');

  await test('new insert -> created', async () => {
    const g = await guard(); const s = await session(g);
    const w = await writeClockInVerification(db, g, input(s, 'first.jpg'));
    assert.strictEqual(w.kind, 'created');
    if (w.kind !== 'created') return;
    assert.strictEqual(w.row.shift_session_id, s);
    assert.strictEqual(w.row.guard_id, g);
    assert.strictEqual(w.row.selfie_url, 'first.jpg');
    assert.strictEqual((await rowsFor(s)).length, 1);
  });

  await test('duplicate, same guard -> existing, same row, first row unchanged', async () => {
    const g = await guard(); const s = await session(g);
    const first = await writeClockInVerification(db, g, input(s, 'first.jpg'));
    const before = await rowsFor(s);
    const second = await writeClockInVerification(db, g, { ...input(s, 'retry.jpg'), verifiedLat: 1, fixAgeMs: 1 });
    assert.strictEqual(second.kind, 'existing');
    if (first.kind !== 'created' || second.kind !== 'existing') return;
    assert.strictEqual(second.row.id, first.row.id);
    assert.deepStrictEqual(second.row, before[0]);
    const after = await rowsFor(s);
    assert.strictEqual(after.length, 1);
    assert.deepStrictEqual(after[0], before[0]);
    assert.strictEqual(after[0].selfie_url, 'first.jpg');
  });

  await test('duplicate, other guard -> conflict, no row leaked, first row unchanged', async () => {
    const a = await guard(); const b = await guard(); const s = await session(a);
    await writeClockInVerification(db, a, input(s, 'first.jpg'));
    const before = await rowsFor(s);
    const w = await writeClockInVerification(db, b, input(s, 'intruder.jpg'));
    assert.deepStrictEqual(w, { kind: 'conflict' });
    const after = await rowsFor(s);
    assert.strictEqual(after.length, 1);
    assert.deepStrictEqual(after[0], before[0]);
  });

  await test('two concurrent writes -> one created, one existing, one row', async () => {
    const g = await guard(); const s = await session(g);
    const [x, y] = await Promise.all([
      writeClockInVerification(db, g, input(s, 'x.jpg')),
      writeClockInVerification(db, g, input(s, 'y.jpg')),
    ]);
    assert.deepStrictEqual([x.kind, y.kind].sort(), ['created', 'existing']);
    const rows = await rowsFor(s);
    assert.strictEqual(rows.length, 1);
    const created = x.kind === 'created' ? x : y;
    if (created.kind === 'conflict') return;
    assert.strictEqual(rows[0].id, created.row.id);
  });

  await test('legal hold still inherited from the session at insert', async () => {
    const g = await guard(); const s = await session(g, true);
    const w = await writeClockInVerification(db, g, input(s, 'held.jpg'));
    assert.strictEqual(w.kind, 'created');
    if (w.kind !== 'created') return;
    assert.strictEqual(w.row.legal_hold, true);
    assert.ok(w.row.legal_hold_at instanceof Date);
  });
}

async function routeTests() {
  console.log('\nroute: POST /api/locations/clock-in-verification\n');

  const app = express();
  app.use(express.json());
  app.use('/api/locations', locationsRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/locations`;

  const tokenFor = async (guardId: string) => {
    const company = (await db.query(`SELECT company_id FROM guards WHERE id = $1`, [guardId])).rows[0].company_id;
    return jwt.sign({ sub: guardId, role: 'guard', company_id: company }, process.env.JWT_SECRET!);
  };
  // 'pending' is a sentinel photoValidation skips, so no S3 call is made.
  const post = async (token: string, sessionId: string, selfie: string | null) => {
    const r = await fetch(`${base}/clock-in-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        shift_session_id: sessionId, selfie_url: selfie, site_photo_url: null,
        verified_lat: 37.0, verified_lng: -122.0, accuracy: 9.5, is_within_geofence: true,
      }),
    });
    return { status: r.status, body: await r.json() as Record<string, any> };
  };

  try {
    const a = await guard(); const b = await guard(); const s = await session(a);
    const ta = await tokenFor(a); const tb = await tokenFor(b);
    let first: { status: number; body: Record<string, any> } | undefined;

    await test('first POST -> 201 with the row', async () => {
      first = await post(ta, s, 'pending');
      assert.strictEqual(first.status, 201);
      assert.strictEqual(first.body.shift_session_id, s);
      assert.strictEqual(first.body.selfie_url, 'pending');
    });

    await test('retry, same guard -> 200, identical body, same row id', async () => {
      const again = await post(ta, s, null);
      assert.strictEqual(again.status, 200);
      assert.deepStrictEqual(again.body, first!.body);
    });

    await test('other guard -> 404 from the ownership check, no row leaked', async () => {
      const r = await post(tb, s, null);
      assert.strictEqual(r.status, 404);
      assert.deepStrictEqual(r.body, { error: 'Shift session not found' });
    });

    await test('exactly one row, first selfie kept', async () => {
      const rows = await rowsFor(s);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, first!.body.id);
      assert.strictEqual(rows[0].selfie_url, 'pending');
    });
  } finally {
    server.close();
  }
}

(async () => {
  await schema();
  await helperTests();
  await routeTests();
  await db.end();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  // Imported app modules may hold timers open; exit explicitly.
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
