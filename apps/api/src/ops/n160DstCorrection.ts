/**
 * N160 — one-off correction for the repeat_days shifts that drifted an hour
 * across a DST change before the fix in routes/shifts.ts (N48 defect 1).
 *
 * RUN IT INSIDE THE GUARD CONTAINER, after the fix is deployed and before
 * 2026-11-01 (Tier 2, Vishnu present):
 *
 *   railway ssh -s guard -e production -- node dist/ops/n160DstCorrection.js
 *   railway ssh -s guard -e production -- node dist/ops/n160DstCorrection.js --apply --expect=N
 *
 * Not `railway run`: the guard service's DATABASE_URL is Railway's private
 * host, which resolves only inside Railway, and the guard's push needs the
 * service's own credentials. With no flags it is a dry run: it prints the
 * plan and writes nothing. `--apply` writes only when the plan holds exactly
 * N corrections. `--confirm-long` is needed as well when a correction leaves
 * a shift over 12 hours (the admin edit's confirm, U5).
 *
 * WHAT DRIFTED. The old loop kept every shift of a series at the base's UTC
 * time of day, so across a DST change inside the series' 28 days the later
 * shifts moved an hour in local time: the start, the end, or both (an
 * overnight that straddles the change keeps its start and is off at the end).
 *
 * FINDING ONE. The base pair is not stored, so each series is rebuilt from the
 * rows: manual shifts at one site by one creator, each inserted within 2 s of
 * the one before (the old loop committed one INSERT per date, so its rows
 * never share created_at; a specific_dates batch, one transaction, always
 * does, and is never a series). A series has at least 4 shifts, because 29
 * days hold every weekday at least 4 times, so a smaller batch (a single
 * shift above all) is never treated as one. The
 * series' first shift by start that no admin has edited since (no
 * shift_schedule_audit row), whatever its status now, is the reference: the
 * base was at most 6 days earlier, on the same side of a DST change unless
 * one fell in between. For each shift of the series that has not
 * started (scheduled or unassigned, start after now), the target is the
 * reference's local start, local end and day offset on that shift's local
 * date, the windows the fixed route builds. A shift that differs from its
 * target drifted.
 *
 * Comparing against the reference, not against the other future shifts, is
 * what the detector first filed under N160 missed: it read only future
 * scheduled rows, so once October's shifts completed, a drifted Nov 1 shift
 * had nothing left to differ from and the detector went quiet.
 *
 *   corrected  start and end each move by exactly the UTC-offset change
 *              between the reference and this shift (what the old loop's
 *              fixed UTC time did); the new start is not in the past; the
 *              shift has no session; no overlap with the guard's other shifts
 *              once every correction is applied.
 *   refused    every other difference (a series near midnight, where the old
 *              loop also moved the date), a shift an admin has edited since it
 *              was created (an edit of exactly an hour looks like drift, and a
 *              correction must never undo it), an inverted window, an overlap,
 *              a start moving into the past, a session. Listed for a person.
 *   suspect    a series whose reference may itself be wrong, because it
 *              straddles a DST change, or a change fell after the series was
 *              created and between 6 days before its first shift (edited or
 *              not) and the reference. Never corrected; listed for Vishnu's
 *              review, because the rows cannot show the base.
 *
 * EACH CORRECTION IS THE ADMIN EDIT of a scheduled or unassigned shift
 * (PATCH /api/shifts/:id, D20): latches cleared; start, end and expires_at
 * moved; one shift_schedule_audit row ('shift_schedule_edited', before and
 * after, actor the super-admin token's sub with role 'vishnu', reason
 * 'N160 DST correction'); after COMMIT, the guard's notification row and push
 * through the edit's own sender, services/shiftEditPush.ts. Every correction
 * commits in ONE transaction, after the plan is re-read under FOR UPDATE and
 * its count matches --expect, and only if a fresh plan inside that
 * transaction then finds nothing left to correct and no corrected shift
 * refused. Each UPDATE returns what it wrote, which must equal the plan.
 * Running it again changes nothing.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { clearScheduleDerivedLatches } from '../services/shiftLatches';
import { overlapPredicateSql } from '../services/shiftOverlap';
import { expiresAtFor } from '../services/retention';
import { isLongShift } from '../constants/longShift';
import { notifyShiftScheduleEdited } from '../services/shiftEditPush';

type Querier = Pick<PoolClient, 'query'>;

export const N160_REASON = 'N160 DST correction';
/** The super-admin token's sub: routes/auth.ts signs the vishnu login with it. */
export const VISHNU_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const HOUR = 3_600_000;

export interface Correction {
  id: string;
  siteName: string;
  tz: string;
  guardId: string | null;
  badge: string | null;
  status: string;
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  long: boolean;
}
export interface Refusal extends Omit<Correction, 'long'> { reason: string }
export interface Suspect {
  refId: string;
  siteName: string;
  tz: string;
  shifts: number;
  futureShifts: number;
  createdAt: Date;
  firstStart: Date;
  reason: string;
}
export interface Plan { corrections: Correction[]; refused: Refusal[]; suspects: Suspect[] }

export class N160Refusal extends Error {}

// One series per run of manual shifts at a site by one creator, inserted
// within 2 s of each other and not all at one instant. The reference is the
// series' first shift by start that has no shift_schedule_audit row; a series
// whose every shift was edited has none and drops out.
// off_* are UTC offsets at the site: at the reference's start and end, and at
// look_from, the later of the series' creation and 6 days before its first
// shift (edited or not): the earliest the base can have been.
const SERIES_SQL = `
  m AS (
    SELECT s.id, s.site_id, s.guard_id, s.created_by, s.status, s.created_at,
           s.scheduled_start, s.scheduled_end,
           EXISTS (SELECT 1 FROM shift_schedule_audit a WHERE a.shift_id = s.id) AS edited,
           CASE WHEN s.created_at - lag(s.created_at) OVER w <= INTERVAL '2 seconds'
                THEN 0 ELSE 1 END AS new_batch
      FROM shifts s
     WHERE s.source = 'manual'
    WINDOW w AS (PARTITION BY s.site_id, s.created_by ORDER BY s.created_at, s.id)
  ),
  b AS (
    SELECT m.*, SUM(new_batch) OVER (PARTITION BY site_id, created_by ORDER BY created_at, id) AS batch_no
      FROM m
  ),
  series AS (
    SELECT b.site_id, b.created_by, b.batch_no, si.timezone AS tz, si.name AS site_name,
           COUNT(*)::int AS n, MIN(b.created_at) AS created_at, MIN(b.scheduled_start) AS first_start,
           (ARRAY_AGG(b.id ORDER BY b.scheduled_start, b.id) FILTER (WHERE NOT b.edited))[1] AS ref_id
      FROM b JOIN sites si ON si.id = b.site_id
     GROUP BY b.site_id, b.created_by, b.batch_no, si.timezone, si.name
    HAVING COUNT(*) >= 4 AND COUNT(DISTINCT b.created_at) > 1
  ),
  ref AS (
    SELECT x.*, (x.look_from AT TIME ZONE x.tz) - (x.look_from AT TIME ZONE 'UTC') AS off_before
      FROM (
        SELECT se.*, r.scheduled_start AS ref_start,
               r.scheduled_start AT TIME ZONE se.tz AS ref_ls,
               r.scheduled_end   AT TIME ZONE se.tz AS ref_le,
               (r.scheduled_start AT TIME ZONE se.tz) - (r.scheduled_start AT TIME ZONE 'UTC') AS off_start,
               (r.scheduled_end   AT TIME ZONE se.tz) - (r.scheduled_end   AT TIME ZONE 'UTC') AS off_end,
               GREATEST(se.created_at, se.first_start - INTERVAL '6 days') AS look_from
          FROM series se JOIN shifts r ON r.id = se.ref_id
      ) x
  ),
  member AS (
    SELECT b.*, ref.ref_id, ref.tz, ref.site_name, ref.ref_ls, ref.ref_le,
           ref.off_start AS ref_off_start, ref.off_end AS ref_off_end,
           (ref.off_start <> ref.off_end OR ref.off_before <> ref.off_start) AS suspect
      FROM b
      JOIN ref ON ref.site_id = b.site_id
              AND ref.created_by IS NOT DISTINCT FROM b.created_by
              AND ref.batch_no = b.batch_no
  )`;

/**
 * The plan: what would be corrected, what is refused, which series are
 * suspect. Reads only. `now` is for the test harness; production passes
 * nothing and the database's NOW() decides what has not started.
 */
export async function planCorrections(db: Querier = pool, now?: Date): Promise<Plan> {
  // One clock for every comparison below: the database's (the transaction's,
  // when applying), unless the harness pins one.
  const dbNow: Date = (await db.query(
    `SELECT COALESCE($1::timestamptz, NOW()) AS now`, [now ? now.toISOString() : null],
  )).rows[0].now;
  const nowParam = dbNow.toISOString();
  const { rows } = await db.query(
    `WITH ${SERIES_SQL}
     SELECT mb.id, mb.site_name, mb.tz, mb.guard_id, g.badge_number AS badge, mb.status, mb.edited,
            mb.scheduled_start AS old_start, mb.scheduled_end AS old_end,
            ((mb.scheduled_start AT TIME ZONE mb.tz)::date + mb.ref_ls::time) AT TIME ZONE mb.tz AS new_start,
            ((mb.scheduled_start AT TIME ZONE mb.tz)::date + (mb.ref_le::date - mb.ref_ls::date)
               + mb.ref_le::time) AT TIME ZONE mb.tz AS new_end,
            -- what the old loop's fixed UTC time did to this shift: the offset change since the reference
            EXTRACT(EPOCH FROM mb.ref_off_start
              - ((mb.scheduled_start AT TIME ZONE mb.tz) - (mb.scheduled_start AT TIME ZONE 'UTC')))::int AS dst_ds,
            EXTRACT(EPOCH FROM mb.ref_off_end
              - ((mb.scheduled_end AT TIME ZONE mb.tz) - (mb.scheduled_end AT TIME ZONE 'UTC')))::int AS dst_de
       FROM member mb
       LEFT JOIN guards g ON g.id = mb.guard_id
      WHERE NOT mb.suspect
        AND mb.status IN ('scheduled', 'unassigned')
        AND mb.scheduled_start > $1::timestamptz
      ORDER BY mb.scheduled_start, mb.id`,
    [nowParam],
  );

  const suspects = (await db.query(
    `WITH ${SERIES_SQL}
     SELECT ref.ref_id, ref.site_name, ref.tz, ref.n, ref.created_at, ref.ref_start,
            (ref.off_start <> ref.off_end) AS straddles,
            COUNT(mb.id) FILTER (WHERE mb.status IN ('scheduled', 'unassigned')
                                   AND mb.scheduled_start > $1::timestamptz)::int AS future
       FROM ref
       JOIN member mb ON mb.ref_id = ref.ref_id
      WHERE ref.off_start <> ref.off_end OR ref.off_before <> ref.off_start
      GROUP BY ref.ref_id, ref.site_name, ref.tz, ref.n, ref.created_at, ref.ref_start, ref.off_start, ref.off_end
     HAVING COUNT(mb.id) FILTER (WHERE mb.status IN ('scheduled', 'unassigned')
                                   AND mb.scheduled_start > $1::timestamptz) > 0
      ORDER BY ref.ref_start`,
    [nowParam],
  )).rows.map((r): Suspect => ({
    refId: r.ref_id, siteName: r.site_name, tz: r.tz, shifts: r.n, futureShifts: r.future,
    createdAt: r.created_at, firstStart: r.ref_start,
    reason: r.straddles
      ? 'its first shift straddles a DST change, so the series\' end time cannot be read from it'
      : 'a DST change fell between 6 days before its first shift and its reference, after it was created: if the old loop made it, its base may be on the other side',
  }));

  const refused: Refusal[] = [];
  let movers: Correction[] = [];
  for (const r of rows) {
    const c: Correction = {
      id: r.id, siteName: r.site_name, tz: r.tz, guardId: r.guard_id, badge: r.badge, status: r.status,
      oldStart: r.old_start, oldEnd: r.old_end, newStart: r.new_start, newEnd: r.new_end,
      long: isLongShift(r.new_start, r.new_end),
    };
    const ds = c.newStart.getTime() - c.oldStart.getTime();
    const de = c.newEnd.getTime() - c.oldEnd.getTime();
    if (ds === 0 && de === 0) continue;                       // matches its series
    const refuse = (reason: string) => { const { long: _l, ...rest } = c; refused.push({ ...rest, reason }); };
    if (r.edited) {
      refuse('edited by an admin since it was created (shift_schedule_audit); a correction must not undo an edit');
    } else if (ds !== r.dst_ds * 1000 || de !== r.dst_de * 1000) {
      refuse('not the shift DST made: start and end must each move by the UTC-offset change since the series\' first shift (near midnight the old loop also moved the date)');
    } else if (c.newEnd.getTime() <= c.newStart.getTime()) {
      refuse('the corrected window does not end after it starts');
    } else if (ds !== 0 && c.newStart.getTime() < dbNow.getTime()) {
      refuse('the corrected start is in the past');
    } else {
      movers.push(c);
    }
  }

  if (movers.length) {
    const withSession = new Set((await db.query(
      `SELECT DISTINCT shift_id FROM shift_sessions WHERE shift_id = ANY($1::uuid[])`,
      [movers.map((c) => c.id)],
    )).rows.map((r) => r.shift_id as string));
    movers = movers.filter((c) => {
      if (!withSession.has(c.id)) return true;
      const { long: _l, ...rest } = c;
      refused.push({ ...rest, reason: 'the shift has a session' });
      return false;
    });
  }

  // Overlap in the END state: each mover's new window against the guard's
  // shifts that are not moving (current windows, the edit's predicate) and
  // against the other movers' new windows. A refusal stops that shift moving,
  // so check again until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    const movingIds = movers.map((c) => c.id);
    for (const c of movers) {
      if (!c.guardId) continue;                                // unassigned rows may stack
      const hit = (await db.query(
        `SELECT s.id FROM shifts s
          WHERE s.id <> ALL($4::uuid[])
            AND ${overlapPredicateSql({
              guardCol: 's.guard_id', statusCol: 's.status',
              startCol: 's.scheduled_start', endCol: 's.scheduled_end',
              guardExpr: '$1', winStart: '$2', winEnd: '$3',
            })}
          LIMIT 1`,
        [c.guardId, c.newStart.toISOString(), c.newEnd.toISOString(), movingIds],
      )).rows[0]?.id as string | undefined;
      const peer = movers.find((o) => o !== c && o.guardId === c.guardId
        && o.newStart < c.newEnd && c.newStart < o.newEnd);
      if (hit || peer) {
        const { long: _l, ...rest } = c;
        refused.push({ ...rest, reason: `the corrected window overlaps shift ${hit ?? peer!.id}` });
        movers = movers.filter((o) => o !== c);
        changed = true;
        break;
      }
    }
  }

  return { corrections: movers, refused, suspects };
}

/** +1 when every correction moves later (autumn), -1 when earlier, 0 if mixed or none. */
export function direction(cs: Correction[]): number {
  const signs = new Set(cs.map((c) => Math.sign(
    (c.newStart.getTime() - c.oldStart.getTime()) || (c.newEnd.getTime() - c.oldEnd.getTime()),
  )));
  return signs.size === 1 ? [...signs][0] : 0;
}

/**
 * Applies the plan in one transaction, or throws N160Refusal having written
 * nothing. Notifies each corrected shift's guard after COMMIT and awaits it.
 */
export async function applyCorrections(opts: {
  expect: number;
  confirmLong: boolean;
  now?: Date;
  log?: (line: string) => void;
}): Promise<Correction[]> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const client = await pool.connect();
  let applied: Correction[] = [];
  try {
    await client.query('BEGIN');
    // As PATCH /:id: give up rather than queue behind a long transaction.
    await client.query(`SET LOCAL lock_timeout = '3s'`);

    const plan = await planCorrections(client, opts.now);
    const cs = plan.corrections;
    if (cs.length !== opts.expect) {
      throw new N160Refusal(`the plan has ${cs.length} correction(s), not the ${opts.expect} expected. Nothing written; run the dry run again.`);
    }
    if (cs.some((c) => c.long) && !opts.confirmLong) {
      throw new N160Refusal('a correction leaves a shift over 12 hours; rerun with --confirm-long once the dry run has been read. Nothing written.');
    }
    const dir = direction(cs);
    if (cs.length && dir === 0) {
      throw new N160Refusal('corrections move both later and earlier; apply them by hand. Nothing written.');
    }

    // The planned rows, re-read under lock: unchanged since the plan, or stop.
    const locked = await client.query(
      `SELECT id, status, scheduled_start, scheduled_end FROM shifts WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [cs.map((c) => c.id)],
    );
    const byId = new Map(locked.rows.map((r) => [r.id as string, r]));
    for (const c of cs) {
      const r = byId.get(c.id);
      if (!r || r.status !== c.status
          || new Date(r.scheduled_start).getTime() !== c.oldStart.getTime()
          || new Date(r.scheduled_end).getTime() !== c.oldEnd.getTime()) {
        throw new N160Refusal(`shift ${c.id} changed since the plan was read. Nothing written.`);
      }
    }

    // Latest first when moving later, earliest first when moving earlier, so
    // no shift passes through a neighbour's window on the way (the guard
    // overlap constraint is checked per statement).
    const ordered = [...cs].sort((a, b) => dir * (b.newStart.getTime() - a.newStart.getTime()));
    for (const c of ordered) {
      await clearScheduleDerivedLatches(c.id, client);
      const u = await client.query(
        `UPDATE shifts
            SET scheduled_start = $1,
                scheduled_end   = $2,
                expires_at      = $3
          WHERE id = $4 AND status = $5 AND scheduled_start = $6 AND scheduled_end = $7
          RETURNING scheduled_start, scheduled_end`,
        [c.newStart.toISOString(), c.newEnd.toISOString(), expiresAtFor('shift', c.newStart),
         c.id, c.status, c.oldStart.toISOString(), c.oldEnd.toISOString()],
      );
      if (u.rowCount !== 1) throw new N160Refusal(`shift ${c.id}: updated ${u.rowCount} rows, not 1. Nothing written.`);
      const w = u.rows[0];
      if (new Date(w.scheduled_start).getTime() !== c.newStart.getTime()
          || new Date(w.scheduled_end).getTime() !== c.newEnd.getTime()) {
        throw new N160Refusal(`shift ${c.id}: wrote ${new Date(w.scheduled_start).toISOString()} – ${new Date(w.scheduled_end).toISOString()}, not the plan's window. Nothing written.`);
      }
      await client.query(
        `INSERT INTO shift_schedule_audit
           (shift_id, action, changed_by, changed_by_role, reason, before, after)
         VALUES ($1, 'shift_schedule_edited', $2, 'vishnu', $3, $4, $5)`,
        [
          c.id, VISHNU_ACTOR_ID, N160_REASON,
          JSON.stringify({ scheduled_start: c.oldStart.toISOString(), scheduled_end: c.oldEnd.toISOString() }),
          JSON.stringify({ scheduled_start: c.newStart.toISOString(), scheduled_end: c.newEnd.toISOString() }),
        ],
      );
    }

    // Counts asserted inside the transaction, then the detector itself.
    const audits = (await client.query(
      `SELECT COUNT(*)::int AS n FROM shift_schedule_audit
        WHERE shift_id = ANY($1::uuid[]) AND reason = $2 AND changed_at = NOW()`,
      [cs.map((c) => c.id), N160_REASON],
    )).rows[0].n as number;
    if (audits !== cs.length) throw new N160Refusal(`${audits} audit row(s) for ${cs.length} correction(s). Nothing written.`);
    const after = await planCorrections(client, opts.now);
    if (after.corrections.length !== 0) {
      throw new N160Refusal(`${after.corrections.length} correction(s) still planned after applying. Nothing written.`);
    }
    // A corrected row now has an audit row, so a wrong write would surface as
    // "refused: edited", never as "still planned". Neither may appear.
    const stray = after.refused.filter((r) => cs.some((c) => c.id === r.id));
    if (stray.length) {
      throw new N160Refusal(`${stray.length} corrected shift(s) no longer match their series (${stray.map((r) => r.id).join(', ')}). Nothing written.`);
    }

    await client.query('COMMIT');
    applied = ordered;
    log(`committed: ${applied.length} correction(s)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const c of applied) {
    if (!c.guardId) continue;
    await notifyShiftScheduleEdited({
      guardId: c.guardId, shiftId: c.id, siteName: c.siteName, siteTz: c.tz,
      newStart: c.newStart, newEnd: c.newEnd,
    }).catch((err) => log(`  notify FAILED for shift ${c.id}: ${String(err)}`));
  }
  return applied;
}

function at(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('weekday')} ${g('month')} ${g('day')} ${g('hour')}:${g('minute')}`;
}
function moved(a: Date, b: Date): string {
  const d = (b.getTime() - a.getTime()) / HOUR;
  return d === 0 ? '0' : `${d > 0 ? '+' : ''}${d}h`;
}
function describe(c: Omit<Correction, 'long'>): string {
  const who = c.guardId ? `guard ${c.guardId.slice(0, 8)} ${c.badge ?? ''}`.trim() : 'unassigned';
  return `  ${c.id}  ${c.siteName}  ${who}  ${c.status}\n` +
         `    ${at(c.oldStart, c.tz)} – ${at(c.oldEnd, c.tz)}  ->  ${at(c.newStart, c.tz)} – ${at(c.newEnd, c.tz)}` +
         `  (${c.tz}; start ${moved(c.oldStart, c.newStart)}, end ${moved(c.oldEnd, c.newEnd)}, ` +
         `${(c.newEnd.getTime() - c.newStart.getTime()) / HOUR} h)`;
}

export function printPlan(plan: Plan, log: (line: string) => void): void {
  log(`planned corrections: ${plan.corrections.length}`);
  for (const c of plan.corrections) log(describe(c) + (c.long ? '  OVER 12 h: needs --confirm-long' : ''));
  if (plan.corrections.length && direction(plan.corrections) === 0) {
    log('  WARNING: these move both later and earlier; --apply will refuse.');
  }
  log(`refused (not corrected; check each by hand): ${plan.refused.length}`);
  for (const r of plan.refused) log(`${describe(r)}\n    reason: ${r.reason}`);
  log(`suspect series (cannot be checked from the rows; review by hand): ${plan.suspects.length}`);
  for (const s of plan.suspects) {
    log(`  first shift ${s.refId}  ${s.siteName}  ${s.shifts} shifts (${s.futureShifts} not started)` +
        `  created ${s.createdAt.toISOString()}  first ${at(s.firstStart, s.tz)} (${s.tz})\n    reason: ${s.reason}`);
  }
}

export async function main(argv: string[], log: (line: string) => void = (l) => console.log(l)): Promise<number> {
  const apply = argv.includes('--apply');
  const confirmLong = argv.includes('--confirm-long');
  const expectArg = argv.find((a) => a.startsWith('--expect='));
  const unknown = argv.filter((a) => a !== '--apply' && a !== '--confirm-long' && !a.startsWith('--expect='));
  const expectText = expectArg ? expectArg.slice('--expect='.length) : '';
  const expect = /^\d+$/.test(expectText) ? Number(expectText) : NaN;
  if (unknown.length || (apply && !Number.isInteger(expect)) || (!apply && expectArg)) {
    log('usage: n160DstCorrection.js                          dry run, writes nothing');
    log('       n160DstCorrection.js --apply --expect=N [--confirm-long]');
    return 2;
  }

  if (!apply) {
    log(`N160 DST correction: DRY RUN, nothing written (${new Date().toISOString()})`);
    const plan = await planCorrections();
    printPlan(plan, log);
    log(`to apply: --apply --expect=${plan.corrections.length}${plan.corrections.some((c) => c.long) ? ' --confirm-long' : ''}`);
    return 0;
  }

  log(`N160 DST correction: APPLY, expecting ${expect} (${new Date().toISOString()})`);
  try {
    const applied = await applyCorrections({ expect, confirmLong, log });
    for (const c of applied) log(describe(c));
    const after = await planCorrections();
    log(`detector after: ${after.corrections.length} planned, ${after.refused.length} refused, ${after.suspects.length} suspect`);
    return 0;
  } catch (err) {
    if (err instanceof N160Refusal) { log(`REFUSED: ${err.message}`); return 1; }
    throw err;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(async (code) => { await pool.end().catch(() => {}); process.exit(code); })
    .catch(async (err) => {
      console.error('[n160] failed; nothing was committed unless a "committed:" line was printed:', err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
