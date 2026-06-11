/**
 * test-guard-site-enforcement.ts — Phase A enforcement of
 * guard_site_assignments as a real permissions surface.
 *
 * Drives the live HTTP endpoint because we need to assert the exact 422
 * messages and the cross-tenant 403, both of which only happen in the
 * route handlers. The DB pool is used only for ephemeral fixture
 * seeding + cleanup; all assertions go through POST /api/shifts and
 * POST /api/guards/:id/assign.
 *
 * Coverage (matches the spec word-for-word):
 *   (1) guard with NO assignment + any site                          → 422
 *   (2) guard assigned to Site A + scheduling at Site B              → 422
 *   (3) guard assigned to Site A + scheduling at Site A today        → 201
 *   (4) repeat_days expanding past assigned_until                    → 422 (whole request)
 *   (5) specific_dates [d1..d5] with d4 outside the window           → 422 mentions d4
 *   (6) unassigned shift (no guard_id) — no enforcement              → 201
 *   (7) cross-tenant: admin of company A assigning company B's guard → 403
 *   (8) duplicate (guard, site, assigned_from)                       → 409
 *
 * Phase A gap-fill — mutation endpoints that change shifts.guard_id:
 *   (9)  PATCH /:id/reassign to a guard with no assignment           → 422
 *   (10) PATCH /:id/reassign to a guard whose assignment expired
 *        before the shift date                                       → 422
 *   (11) PATCH /:id/reassign to a properly-assigned guard            → 200
 *   (12) PATCH /:id/assign-guard on an unassigned shift to a guard
 *        with no assignment                                          → 422
 *        ("clear guard_id" case: both endpoints currently reject a
 *        null guard_id with 400, so there is no clear-path to gate.)
 *
 * Prereqs:
 *   - apps/api dev server on http://localhost:3001
 *   - DATABASE_URL set (shared with prod via .env in this repo)
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-guard-site-enforcement.ts
 *   railway run npm run script:test-guard-site-enforcement
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { pacificTodayStr } from '../src/services/pacificDate';

const API = process.env.API_URL ?? 'http://localhost:3001';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

let pass = 0;
let fail = 0;
function ok(msg: string)  { console.log(`  ✓ ${msg}`); pass++; }
function bad(msg: string) { console.error(`  ✗ ${msg}`); fail++; process.exitCode = 1; }

function todayPlus(days: number): string {
  const todayPT = pacificTodayStr();
  const [y, m, d] = todayPT.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function mintToken(role: 'company_admin' | 'vishnu', companyId?: string): string {
  return jwt.sign(
    role === 'vishnu'
      ? { sub: '00000000-0000-0000-0000-000000000000', role, jti: 'test-enf-v' }
      : { sub: '00000000-aaaa-aaaa-aaaa-000000000001', role, company_id: companyId, jti: 'test-enf-ca' },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' },
  );
}

async function post(token: string, path: string, body: any): Promise<{ status: number; body: any }> {
  return req('POST', token, path, body);
}
async function patch(token: string, path: string, body: any): Promise<{ status: number; body: any }> {
  return req('PATCH', token, path, body);
}
async function req(method: 'POST'|'PATCH', token: string, path: string, body: any): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

interface Fixtures {
  companyA: { id: string; admin: string; siteA: string; siteB: string; guard: string };
  companyB: { id: string; admin: string; guard: string };
}

async function seed(): Promise<Fixtures> {
  // Two isolated test companies (so we can prove cross-tenant rejection).
  const cA = (await pool.query(
    `INSERT INTO companies (name, default_photo_limit, is_active)
     VALUES ('Enforce-Test A', 5, true) RETURNING id`)).rows[0].id;
  const cB = (await pool.query(
    `INSERT INTO companies (name, default_photo_limit, is_active)
     VALUES ('Enforce-Test B', 5, true) RETURNING id`)).rows[0].id;

  // Two sites in A, one in B.
  const siteA = (await pool.query(
    `INSERT INTO sites (company_id, name, address, contract_start, is_active) VALUES ($1, 'EnfA-Site-1', '1', CURRENT_DATE, true) RETURNING id`, [cA])).rows[0].id;
  const siteB = (await pool.query(
    `INSERT INTO sites (company_id, name, address, contract_start, is_active) VALUES ($1, 'EnfA-Site-2', '2', CURRENT_DATE, true) RETURNING id`, [cA])).rows[0].id;
  await pool.query(
    `INSERT INTO sites (company_id, name, address, contract_start, is_active) VALUES ($1, 'EnfB-Site-1', '3', CURRENT_DATE, true)`, [cB]);

  // One guard per company.
  const guardA = (await pool.query(
    `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
     VALUES ($1, 'Enf A Guard', $2, 'x', $3) RETURNING id`,
    [cA, `enfa-${Date.now()}@example.com`, `ENFA-${Date.now()}`])).rows[0].id;
  const guardB = (await pool.query(
    `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
     VALUES ($1, 'Enf B Guard', $2, 'x', $3) RETURNING id`,
    [cB, `enfb-${Date.now()}@example.com`, `ENFB-${Date.now()}`])).rows[0].id;

  return {
    companyA: { id: cA, admin: mintToken('company_admin', cA), siteA, siteB, guard: guardA },
    companyB: { id: cB, admin: mintToken('company_admin', cB), guard: guardB },
  };
}

async function cleanup(f: Fixtures) {
  // shift_reassignments.old_guard_id / new_guard_id are FKs WITHOUT cascade,
  // so a top-down companies-CASCADE→guards delete fails if Phase A audit
  // rows reference test guards. Drop them via the shift cascade first
  // (shift_reassignments.shift_id FK *does* cascade from shifts).
  await pool.query(
    `DELETE FROM shifts
       WHERE site_id IN (SELECT id FROM sites WHERE company_id IN ($1, $2))
          OR guard_id IN (SELECT id FROM guards WHERE company_id IN ($1, $2))`,
    [f.companyA.id, f.companyB.id],
  );
  await pool.query(`DELETE FROM companies WHERE id IN ($1, $2)`, [f.companyA.id, f.companyB.id]);
  // Remaining FK cascades wipe sites/guards/guard_site_assignments.
}

(async function main() {
  console.log('test-guard-site-enforcement.ts — Phase A');
  const f = await seed();
  try {
    const today  = pacificTodayStr();
    const future = todayPlus(60);

    // ── (1) guard with NO assignment + any site → 422 ─────────────────
    {
      const r = await post(f.companyA.admin, '/api/shifts', {
        site_id: f.companyA.siteA, guard_id: f.companyA.guard,
        scheduled_start: `${future}T09:00:00-07:00`,
        scheduled_end:   `${future}T17:00:00-07:00`,
      });
      if (r.status === 422 && /is not assigned to this site/i.test(r.body?.error ?? '')) {
        ok('(1) no assignment → 422');
      } else bad(`(1) expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // Assign guard A to site A (open-ended) for the remaining cases.
    {
      const a = await post(f.companyA.admin, `/api/guards/${f.companyA.guard}/assign`, {
        site_id: f.companyA.siteA, assigned_from: today, assigned_until: null,
      });
      if (a.status !== 201) { bad(`assign setup failed: ${a.status} ${JSON.stringify(a.body)}`); return; }
    }

    // ── (2) assigned to A, schedule at B → 422 ─────────────────────────
    {
      const r = await post(f.companyA.admin, '/api/shifts', {
        site_id: f.companyA.siteB, guard_id: f.companyA.guard,
        scheduled_start: `${future}T09:00:00-07:00`,
        scheduled_end:   `${future}T17:00:00-07:00`,
      });
      if (r.status === 422 && /is not assigned to this site/i.test(r.body?.error ?? '')) {
        ok('(2) assigned to A, schedule B → 422');
      } else bad(`(2) expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (3) assigned to A, schedule at A today → 201 ───────────────────
    {
      const r = await post(f.companyA.admin, '/api/shifts', {
        site_id: f.companyA.siteA, guard_id: f.companyA.guard,
        scheduled_start: `${today}T23:00:00-07:00`,
        scheduled_end:   `${today}T23:59:00-07:00`,
      });
      if (r.status === 201) ok('(3) assigned + same site → 201');
      else bad(`(3) expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (4) repeat_days expanding past assigned_until → 422 ───────────
    // Close the open-ended assignment by inserting one with a near-term
    // until-date. We delete the open-ended row first to avoid the unique
    // constraint and so the cutoff date is the only signal.
    await pool.query(
      `DELETE FROM guard_site_assignments WHERE guard_id=$1 AND site_id=$2`,
      [f.companyA.guard, f.companyA.siteA],
    );
    const cutoff = todayPlus(7);
    await pool.query(
      `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from, assigned_until)
       VALUES ($1, $2, $3, $4)`,
      [f.companyA.guard, f.companyA.siteA, today, cutoff],
    );
    {
      // Use a baseStart 14 days out so the expansion will straddle the cutoff.
      const baseStart = todayPlus(14);
      const r = await post(f.companyA.admin, '/api/shifts', {
        site_id: f.companyA.siteA, guard_id: f.companyA.guard,
        scheduled_start: `${today}T09:00:00-07:00`,
        scheduled_end:   `${today}T11:00:00-07:00`,
        repeat_days: [0, 1, 2, 3, 4, 5, 6], // every day → guaranteed to cross cutoff
      });
      if (r.status === 422 && /is not assigned to this site on \d{4}-\d{2}-\d{2}/i.test(r.body?.error ?? '')) {
        // Whole request rejected — confirm by counting shifts for this guard.
        const rows = await pool.query(
          `SELECT COUNT(*)::int AS n FROM shifts WHERE guard_id = $1
           AND (scheduled_start AT TIME ZONE 'America/Los_Angeles')::date > $2::date`,
          [f.companyA.guard, today],
        );
        if (rows.rows[0].n === 0) ok(`(4) repeat past assigned_until → 422 (whole batch dropped)`);
        else bad(`(4) expected 0 future rows after 422, got ${rows.rows[0].n}`);
      } else bad(`(4) expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
      // Suppress unused-warning for baseStart by referencing it.
      void baseStart;
    }

    // ── (5) specific_dates where the 4th date is outside the window → 422 mentions d4 ──
    {
      // Window: today..cutoff (today + 7). Pick 5 dates, the 4th lands outside.
      const dates = [todayPlus(1), todayPlus(2), todayPlus(3), todayPlus(9), todayPlus(10)];
      const r = await post(f.companyA.admin, '/api/shifts', {
        mode: 'specific_dates',
        site_id: f.companyA.siteA, guard_id: f.companyA.guard,
        start_time: '09:00', end_time: '10:00', dates,
      });
      const re = new RegExp(`is not assigned to this site on ${dates[3]}`, 'i');
      if (r.status === 422 && re.test(r.body?.error ?? '')) {
        ok(`(5) specific_dates: 4th date ${dates[3]} outside → 422 names it`);
      } else bad(`(5) expected 422 naming ${dates[3]}, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (6) unassigned (no guard_id) → 201, no enforcement ─────────────
    {
      const r = await post(f.companyA.admin, '/api/shifts', {
        site_id: f.companyA.siteA,
        scheduled_start: `${future}T09:00:00-07:00`,
        scheduled_end:   `${future}T17:00:00-07:00`,
      });
      if (r.status === 201) ok('(6) unassigned shift → 201 (enforcement bypassed)');
      else bad(`(6) expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (7) cross-tenant: A's admin assigning B's guard → 403 ──────────
    {
      const r = await post(f.companyA.admin, `/api/guards/${f.companyB.guard}/assign`, {
        site_id: f.companyA.siteA, assigned_from: today,
      });
      if (r.status === 403) ok('(7) cross-tenant assign → 403');
      else bad(`(7) expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (8) duplicate (guard, site, assigned_from) → 409 ───────────────
    {
      const r = await post(f.companyA.admin, `/api/guards/${f.companyA.guard}/assign`, {
        site_id: f.companyA.siteA, assigned_from: today,
      });
      if (r.status === 409 && /already exists/i.test(r.body?.error ?? '')) {
        ok('(8) duplicate assignment → 409');
      } else bad(`(8) expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── Phase A gap-fill — mutation endpoints (assign-guard / reassign) ──
    // Seed three extra guards in company A:
    //   guardOk  — currently assigned to siteA
    //   guardNo  — never assigned
    //   guardExp — assignment expired before today
    // Plus two seed shifts:
    //   shiftAssigned   — at siteA today, owned by the currently-assigned
    //                     guard (we re-use f.companyA.guard which got
    //                     an assignment covering today..today+7 in case 4)
    //   shiftUnassigned — at siteA today, no guard
    const ts = Date.now();
    const guardOk = (await pool.query(
      `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
       VALUES ($1, 'Enf A Guard OK', $2, 'x', $3) RETURNING id`,
      [f.companyA.id, `enfa-ok-${ts}@example.com`, `ENFA-OK-${ts}`])).rows[0].id;
    const guardNo = (await pool.query(
      `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
       VALUES ($1, 'Enf A Guard NoAssign', $2, 'x', $3) RETURNING id`,
      [f.companyA.id, `enfa-no-${ts}@example.com`, `ENFA-NO-${ts}`])).rows[0].id;
    const guardExp = (await pool.query(
      `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
       VALUES ($1, 'Enf A Guard Expired', $2, 'x', $3) RETURNING id`,
      [f.companyA.id, `enfa-exp-${ts}@example.com`, `ENFA-EXP-${ts}`])).rows[0].id;

    // guardOk: open-ended today assignment
    await pool.query(
      `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from, assigned_until)
       VALUES ($1, $2, $3, NULL)`,
      [guardOk, f.companyA.siteA, today]);
    // guardExp: assigned today-30..today-1 (window ends BEFORE today's shift)
    await pool.query(
      `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from, assigned_until)
       VALUES ($1, $2, $3::date - INTERVAL '30 days', $3::date - INTERVAL '1 day')`,
      [guardExp, f.companyA.siteA, today]);

    // Seed shifts on a future date so the auto-complete cron hasn't
    // already settled them (it runs every 5 min on scheduled_end <= NOW;
    // a same-day afternoon slot would have flipped to 'missed' by the
    // time this test reaches it). shiftAssigned belongs to f.companyA.guard
    // (assignment covers today..today+7 from case 4 — today+5 is in range).
    // guardOk's assignment is open-ended; guardExp's expired before today.
    const shiftDateStr = todayPlus(5);
    const shiftAssigned = (await pool.query(
      `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
       VALUES ($1, $2,
               ($3::date + '14:00'::time) AT TIME ZONE 'America/Los_Angeles',
               ($3::date + '15:00'::time) AT TIME ZONE 'America/Los_Angeles',
               'scheduled')
       RETURNING id`,
      [f.companyA.guard, f.companyA.siteA, shiftDateStr])).rows[0].id;
    const shiftUnassigned = (await pool.query(
      `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
       VALUES (NULL, $1,
               ($2::date + '16:00'::time) AT TIME ZONE 'America/Los_Angeles',
               ($2::date + '17:00'::time) AT TIME ZONE 'America/Los_Angeles',
               'unassigned')
       RETURNING id`,
      [f.companyA.siteA, shiftDateStr])).rows[0].id;

    // ── (9) reassign to a guard with no assignment → 422 ───────────────
    {
      const r = await patch(f.companyA.admin, `/api/shifts/${shiftAssigned}/reassign`, {
        new_guard_id: guardNo, reason: 'phaseA-gap-9',
      });
      if (r.status === 422 && /is not assigned to this site/i.test(r.body?.error ?? '')) {
        ok('(9) reassign to no-assignment guard → 422');
      } else bad(`(9) expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (10) reassign to a guard whose assignment expired → 422 ────────
    {
      const r = await patch(f.companyA.admin, `/api/shifts/${shiftAssigned}/reassign`, {
        new_guard_id: guardExp, reason: 'phaseA-gap-10',
      });
      const re = new RegExp(`is not assigned to this site on ${shiftDateStr}`, 'i');
      if (r.status === 422 && re.test(r.body?.error ?? '')) {
        ok('(10) reassign to expired-window guard → 422 names shift date');
      } else bad(`(10) expected 422 naming ${shiftDateStr}, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (11) reassign to a properly-assigned guard → 200 ───────────────
    {
      const r = await patch(f.companyA.admin, `/api/shifts/${shiftAssigned}/reassign`, {
        new_guard_id: guardOk, reason: 'phaseA-gap-11',
      });
      if (r.status === 200) ok('(11) reassign to currently-assigned guard → 200');
      else bad(`(11) expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (12) assign-guard on unassigned shift to no-assignment guard → 422 ──
    {
      const r = await patch(f.companyA.admin, `/api/shifts/${shiftUnassigned}/assign-guard`, {
        guard_id: guardNo,
      });
      if (r.status === 422 && /is not assigned to this site/i.test(r.body?.error ?? '')) {
        ok('(12) assign-guard to no-assignment guard → 422');
      } else bad(`(12) expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
    }
  } finally {
    await cleanup(f);
    await pool.end();
  }

  console.log(`\n  pass=${pass}  fail=${fail}`);
  if (fail === 0) console.log('✓ test-guard-site-enforcement PASSED');
  else            console.error('✗ test-guard-site-enforcement FAILED');
})().catch((err) => {
  console.error('test-guard-site-enforcement error:', err);
  process.exit(1);
});
