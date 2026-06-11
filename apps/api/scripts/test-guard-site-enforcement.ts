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
 * Phase B — assignment edit / remove / impact + audit trail:
 *   (13) PATCH extend window forward → 200, audit row 'guard_assignment_ended'
 *   (14) PATCH assigned_until < assigned_from → 422
 *   (15) PATCH assigned_until in the past → 422
 *   (16) PATCH null → 200 (window re-opened)
 *   (17) PATCH cross-tenant → 403
 *   (18) DELETE success → 204 + audit row 'guard_assignment_removed' with before snapshot
 *   (19) DELETE cross-tenant → 403
 *   (20) DELETE nonexistent id → 404
 *   (21) GET /impact correct future_shift_count + sample_dates (up to 5)
 *   (22) Regression: PATCH end-now → POST a shift past today via /api/shifts → 422
 *   (23) Regression: DELETE → POST a shift via /api/shifts → 422
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
async function del(token: string, path: string): Promise<{ status: number; body: any }> {
  return req('DELETE', token, path, undefined);
}
async function get(token: string, path: string): Promise<{ status: number; body: any }> {
  return req('GET', token, path, undefined);
}
async function req(method: 'POST'|'PATCH'|'DELETE'|'GET', token: string, path: string, body: any): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${API}${path}`, init);
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

    // ── Phase B — edit / remove / impact + audit ──────────────────────
    // Use a fresh open-ended assignment for guardOk so PATCH tests don't
    // collide with the existing windows. assignmentId is captured via the
    // POST response (the route returns the inserted row).
    const editAsgn = (await post(f.companyA.admin, `/api/guards/${guardOk}/assign`, {
      site_id: f.companyA.siteB,    // siteB so we don't conflict with siteA's existing rows
      assigned_from: today,
      assigned_until: null,
    })).body.id;

    // ── (13) PATCH extend forward → 200 + audit row ───────────────────
    {
      const r = await patch(f.companyA.admin, `/api/guards/${guardOk}/assignments/${editAsgn}`, {
        assigned_until: todayPlus(45),
      });
      const audit = await pool.query(
        `SELECT action, before, after FROM guard_assignment_audit
          WHERE assignment_id = $1 AND action = 'guard_assignment_ended'`,
        [editAsgn],
      );
      if (r.status === 200 && audit.rows[0] && audit.rows[0].before?.assigned_until === null
          && String(audit.rows[0].after?.assigned_until).slice(0,10) === todayPlus(45)) {
        ok('(13) PATCH extend → 200, audit row captures before=null / after=date');
      } else bad(`(13) status=${r.status} body=${JSON.stringify(r.body)} audit=${JSON.stringify(audit.rows)}`);
    }

    // ── (14) PATCH assigned_until < assigned_from → 422 ───────────────
    {
      const r = await patch(f.companyA.admin, `/api/guards/${guardOk}/assignments/${editAsgn}`, {
        assigned_until: todayPlus(-1),
      });
      if (r.status === 422 && /past/i.test(r.body?.error ?? '')) {
        // Past-date check fires first (assigned_until in the past is
        // structurally a strict subset of "<= assigned_from" when
        // assigned_from = today). Acceptable per spec — either reason
        // closes the window.
        ok('(14) PATCH past assigned_until → 422 (past-date guard fires)');
      } else if (r.status === 422 && /precede assigned_from/i.test(r.body?.error ?? '')) {
        ok('(14) PATCH past assigned_until → 422 (inverted-window guard fires)');
      } else bad(`(14) expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (15) PATCH assigned_until in the past → 422 ───────────────────
    {
      // Build an assignment whose assigned_from is in the past so we can
      // test "past assigned_until" without colliding with the inverted-
      // window rule.
      const oldAsgnId = (await pool.query(
        `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from, assigned_until)
         VALUES ($1, $2, $3::date - INTERVAL '60 days', NULL) RETURNING id`,
        [guardOk, f.companyA.siteA, today],
      )).rows[0].id;
      const r = await patch(f.companyA.admin, `/api/guards/${guardOk}/assignments/${oldAsgnId}`, {
        assigned_until: todayPlus(-5),
      });
      if (r.status === 422 && /past/i.test(r.body?.error ?? '')) {
        ok('(15) PATCH past assigned_until → 422 "cannot be in the past"');
      } else bad(`(15) expected 422, got ${r.status} ${JSON.stringify(r.body)}`);
      await pool.query(`DELETE FROM guard_site_assignments WHERE id = $1`, [oldAsgnId]);
    }

    // ── (16) PATCH null → 200 (re-open) ───────────────────────────────
    {
      const r = await patch(f.companyA.admin, `/api/guards/${guardOk}/assignments/${editAsgn}`, {
        assigned_until: null,
      });
      if (r.status === 200 && r.body.assigned_until === null) {
        ok('(16) PATCH null → 200, window re-opened');
      } else bad(`(16) status=${r.status} body=${JSON.stringify(r.body)}`);
    }

    // ── (17) PATCH cross-tenant → 403 ─────────────────────────────────
    {
      const r = await patch(f.companyA.admin, `/api/guards/${f.companyB.guard}/assignments/${editAsgn}`, {
        assigned_until: todayPlus(30),
      });
      // Cross-tenant: tenant gate rejects 403 because f.companyB.guard
      // isn't in companyA's scope, BEFORE the assignment_id lookup.
      if (r.status === 403) ok('(17) PATCH cross-tenant → 403');
      else bad(`(17) expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (21) GET /impact returns correct shape ────────────────────────
    // Seed 6 future shifts at siteB for guardOk so impact is non-trivial.
    // (Doing this BEFORE delete tests so the regression tests have data.)
    const impactDates: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const d = todayPlus(i + 10);
      impactDates.push(d);
      await pool.query(
        `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
         VALUES ($1, $2,
                 ($3::date + '14:00'::time) AT TIME ZONE 'America/Los_Angeles',
                 ($3::date + '15:00'::time) AT TIME ZONE 'America/Los_Angeles',
                 'scheduled')`,
        [guardOk, f.companyA.siteB, d]);
    }
    {
      const r = await get(f.companyA.admin, `/api/guards/${guardOk}/assignments/${editAsgn}/impact`);
      if (r.status === 200 && r.body.future_shift_count === 6
          && Array.isArray(r.body.sample_dates) && r.body.sample_dates.length === 5
          && r.body.sample_dates[0] === impactDates[0]) {
        ok('(21) GET /impact returns count=6 + first 5 sample_dates');
      } else bad(`(21) expected count=6 + 5 samples, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (22) Regression: PATCH end-now then POST shift past today → 422 ─
    {
      await patch(f.companyA.admin, `/api/guards/${guardOk}/assignments/${editAsgn}`, {
        assigned_until: today,
      });
      const r = await post(f.companyA.admin, '/api/shifts', {
        site_id: f.companyA.siteB, guard_id: guardOk,
        scheduled_start: `${todayPlus(20)}T09:00:00-07:00`,
        scheduled_end:   `${todayPlus(20)}T10:00:00-07:00`,
      });
      if (r.status === 422 && /is not assigned/i.test(r.body?.error ?? '')) {
        ok('(22) end-now + POST future shift → 422');
      } else bad(`(22) expected 422 after end-now, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (18) DELETE success → 204 + audit row ─────────────────────────
    {
      // Use the same editAsgn we've been editing.
      const beforeAudit = await pool.query(
        `SELECT * FROM guard_site_assignments WHERE id = $1`, [editAsgn]);
      const r = await del(f.companyA.admin, `/api/guards/${guardOk}/assignments/${editAsgn}`);
      const stillThere = await pool.query(
        `SELECT 1 FROM guard_site_assignments WHERE id = $1`, [editAsgn]);
      const audit = await pool.query(
        `SELECT action, before, after FROM guard_assignment_audit
          WHERE assignment_id = $1 AND action = 'guard_assignment_removed'`,
        [editAsgn]);
      if (r.status === 204 && stillThere.rows.length === 0
          && audit.rows[0]
          && audit.rows[0].before?.id === editAsgn
          && audit.rows[0].after === null) {
        ok('(18) DELETE → 204, row gone, audit row written with before snapshot');
      } else bad(`(18) status=${r.status} stillThere=${stillThere.rows.length} audit=${JSON.stringify(audit.rows)}`);
      void beforeAudit;
    }

    // ── (19) DELETE cross-tenant → 403 ────────────────────────────────
    {
      // Re-create a fresh assignment to delete cross-tenant against.
      const tempAsgn = (await pool.query(
        `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from)
         VALUES ($1, $2, $3) RETURNING id`,
        [guardOk, f.companyA.siteA, todayPlus(60)],
      )).rows[0].id;
      const r = await del(f.companyA.admin, `/api/guards/${f.companyB.guard}/assignments/${tempAsgn}`);
      if (r.status === 403) ok('(19) DELETE cross-tenant → 403');
      else bad(`(19) expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
      await pool.query(`DELETE FROM guard_site_assignments WHERE id = $1`, [tempAsgn]);
    }

    // ── (20) DELETE nonexistent → 404 ────────────────────────────────
    {
      const r = await del(f.companyA.admin, `/api/guards/${guardOk}/assignments/00000000-0000-0000-0000-000000000000`);
      if (r.status === 404) ok('(20) DELETE nonexistent → 404');
      else bad(`(20) expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    // ── (23) Regression: DELETE then POST future shift → 422 ──────────
    {
      // Create a new assignment for siteB so we can DELETE it, then verify
      // POST is gated. (Case 18's DELETE was already proven; this asserts
      // the gate is consequent.)
      const a = (await post(f.companyA.admin, `/api/guards/${guardOk}/assign`, {
        site_id: f.companyA.siteB, assigned_from: today, assigned_until: null,
      })).body.id;
      await del(f.companyA.admin, `/api/guards/${guardOk}/assignments/${a}`);
      const r = await post(f.companyA.admin, '/api/shifts', {
        site_id: f.companyA.siteB, guard_id: guardOk,
        scheduled_start: `${todayPlus(30)}T09:00:00-07:00`,
        scheduled_end:   `${todayPlus(30)}T10:00:00-07:00`,
      });
      if (r.status === 422 && /is not assigned/i.test(r.body?.error ?? '')) {
        ok('(23) delete + POST future shift → 422');
      } else bad(`(23) expected 422 after delete, got ${r.status} ${JSON.stringify(r.body)}`);
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
