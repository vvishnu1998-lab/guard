/**
 * Unstaffed Post Warning — runs every five minutes.
 *
 * Emails a company's admins when one of their posts starts within the hour
 * with NO GUARD ASSIGNED, while there is still time to cover it.
 *
 * ─── WHY THIS JOB EXISTS AT ALL (N60) ─────────────────────────────────
 *
 * A shift with nobody on it used to pass its start time with an empty post
 * and no alarm anywhere, and the silence was DOUBLE:
 *
 *   1. jobs/missedShiftAlert.ts selects `status = 'scheduled'`. A shift with
 *      no guard is status='unassigned' and never matched.
 *   2. services/email.ts sendMissedShiftAlert INNER JOINs guards on
 *      sh.guard_id. Even with (1) widened, a null guard_id yields zero rows
 *      and the function returns silently — no email, and no error either.
 *
 * Which is why this is a NEW job rather than a widened predicate: fixing
 * only (1) would have produced a change that looked correct, sent nothing,
 * and reported nothing.
 *
 * ─── WHY T-1h AND NOT T+10 ────────────────────────────────────────────
 *
 * A post ABOUT TO go unstaffed is actionable; one already unstaffed is a
 * report. Admins mostly know their own gaps, so this is a reminder with time
 * to act on it, not an incident notice. That is also why it is amber and
 * says WARNING, and why nothing in it says "missed" — see
 * renderUnstaffedPostWarning.
 *
 * ─── THE STRUCTURAL LIMIT: SHIFTS THIS CAN NEVER CATCH ────────────────
 *
 * The window is a fixed band 55-65 minutes ahead. A shift that BECOMES
 * unstaffed later than 55 minutes before it starts never enters that band
 * and is never warned about. No T-1h alert can catch it — by the time the
 * row exists in a warnable state, the hour it would have warned about is
 * already gone.
 *
 * This is not hypothetical. Production has exactly one instance: a shift at
 * `william pen hotel` created 2026-09-10T04:09:23Z for an 05:00Z start — 50
 * minutes ahead — whose guard was removed by a deactivation 35 seconds
 * later. It was never in the band for a single tick.
 *
 * Widening the band is NOT the fix: a wider band warns about shifts that are
 * still actively being scheduled, which is noise at best and wrong at worst.
 * A same-hour gap needs a different mechanism (something that fires on the
 * unassign itself, not on a clock). Recorded here so the next person finds
 * this as a known limit rather than deriving it from a silent miss.
 *
 * ─── WHY THIS IS BESIDE preShiftReminder AND NOT INSIDE IT ────────────
 *
 * preShiftReminder computes the identical window and already LEFT JOINs
 * guards, so folding this in looks tempting. It would be a mistake, because
 * the two need OPPOSITE STAMPING POLICIES in the same loop:
 *
 *   preShiftReminder stamps UNCONDITIONALLY — its Alerts-tab row is the
 *   source of truth and FCM is best-effort, so a push failure must NOT cause
 *   a retry.
 *
 *   This job must NOT stamp when every recipient failed, or a SendGrid
 *   outage silently eats the warning.
 *
 * Two stamping policies in one loop is a bug waiting to be written. They
 * also differ in recipient (guard vs admin), transport (FCM vs SendGrid, and
 * SendGrid carries the whole failure-suppression machinery in email.ts that
 * preShiftReminder has no use for), and failure blast radius.
 *
 * What they DO share is the window, and that lives in
 * constants/preShiftWindow.ts precisely so the two cannot drift apart. The
 * two predicates are complementary — preShiftReminder fires when guard_id is
 * set, this fires when the shift has nobody on it — so a shift should see
 * exactly one of them.
 */
import { runJob } from './_run';
import { pool } from '../db/pool';
import { preShiftWindowSql } from '../constants/preShiftWindow';
import { sendUnstaffedPostWarning, UnstaffedPostRow } from '../services/email';

interface ClaimedRow extends UnstaffedPostRow {
  company_id:   string;
  company_name: string;
}

runJob('unstaffedPostWarning', '*/5 * * * *', async () => {
  let claimedCount = 0;
  let companies    = 0;
  let sent         = 0;
  let released     = 0;
  let noAdmins     = 0;

  try {
    // ── 1. CLAIM, in one statement ───────────────────────────────────────
    //
    // The stamp goes on BEFORE the send, not after. node-cron does not
    // serialise ticks, so a tick that overran its five-minute interval would
    // overlap the next one; with a SELECT-then-send-then-stamp shape both
    // ticks read the row as unstamped and both send. That is the race
    // Phase E found in three existing jobs, and the reason this one is
    // shaped like pingReminder's claimWindow instead: compare-and-set with
    // RETURNING, and act only on what comes back.
    //
    // The `IS NULL` in the WHERE is what makes it a claim rather than a
    // write. Under READ COMMITTED a concurrent UPDATE that finds one of
    // these rows locked waits for the first transaction, then RE-EVALUATES
    // the WHERE against the newly committed row — sees the stamp, and skips
    // it. So the second tick claims nothing and sends nothing, without any
    // explicit locking.
    const claim = await pool.query<{ id: string }>(
      `UPDATE shifts
          SET unstaffed_warning_sent_at = NOW()
        WHERE status = 'unassigned'
          AND unstaffed_warning_sent_at IS NULL
          AND ${preShiftWindowSql('scheduled_start')}
        RETURNING id`,
    );
    claimedCount = claim.rowCount ?? 0;
    if (claimedCount === 0) return;

    const claimedIds = claim.rows.map((r) => r.id);

    // ── 2. Hydrate what the email needs ──────────────────────────────────
    //
    // Keyed on the claimed ids, never re-running the window predicate: the
    // claim already decided the set, and re-deriving it could return a
    // different one (the window moves between statements).
    const { rows } = await pool.query<ClaimedRow>(
      `SELECT sh.id,
              sh.scheduled_start,
              sh.scheduled_end,
              si.id       AS site_id,
              si.name     AS site_name,
              si.address  AS site_address,
              si.timezone AS site_tz,
              co.id       AS company_id,
              co.name     AS company_name
         FROM shifts sh
         JOIN sites     si ON si.id = sh.site_id
         JOIN companies co ON co.id = si.company_id
        WHERE sh.id = ANY($1::uuid[])
        ORDER BY co.name, sh.scheduled_start, si.name`,
      [claimedIds],
    );

    // ── 3. ONE email per company, listing every warned shift ─────────────
    //
    // Per-shift mail is a noise generator with no unusual data required:
    // eight production shifts share a single (site_id, scheduled_start), so
    // an admin would get eight near-identical messages in one ten-minute
    // window. See sendUnstaffedPostWarning's docblock for the measurement.
    const byCompany = new Map<string, ClaimedRow[]>();
    for (const r of rows) {
      const bucket = byCompany.get(r.company_id) ?? [];
      bucket.push(r);
      byCompany.set(r.company_id, bucket);
    }
    companies = byCompany.size;

    for (const [companyId, companyRows] of byCompany) {
      const ids = companyRows.map((r) => r.id);
      let result: { succeeded: number; failed: number; admins: number };

      try {
        result = await sendUnstaffedPostWarning(companyId, companyRows);
      } catch (err) {
        // sendUnstaffedPostWarning does not throw by design, so reaching
        // here means something unexpected (DB down mid-lookup). Treat it as
        // a total failure so the claim is released and a later tick retries.
        console.error(`[unstaffedPostWarning] send threw for company=${companyId}:`, err);
        result = { succeeded: 0, failed: 0, admins: 0 };
      }

      // ── 4. RELEASE on total failure ────────────────────────────────────
      //
      // Nobody was reached, so the claim has to come off or the warning is
      // silently lost — a stamped row never re-enters the window. Releasing
      // costs at most one retry: the band is ten minutes wide against a
      // five-minute cron, so a released row gets one more tick and then
      // ages out of the window on its own. It cannot loop.
      //
      // A no-admin tenant is released for the same reason and is bounded the
      // same way; sendUnstaffedPostWarning has already reported it to Sentry.
      if (result.succeeded === 0) {
        const rel = await pool.query(
          `UPDATE shifts SET unstaffed_warning_sent_at = NULL WHERE id = ANY($1::uuid[])`,
          [ids],
        );
        released += rel.rowCount ?? 0;
        if (result.admins === 0) noAdmins += 1;
        console.warn(
          `[unstaffedPostWarning] company=${companyId} shifts=${ids.length} ` +
          `admins=${result.admins} — nobody reached, claim released`,
        );
        continue;
      }

      sent += 1;
      for (const r of companyRows) {
        console.log(
          `[unstaffedPostWarning] warned shift=${r.id} site="${r.site_name}" ` +
          `start=${new Date(r.scheduled_start).toISOString()} company=${r.company_name}`,
        );
      }
    }
  } catch (err) {
    // A throw before or during the claim leaves nothing stamped, so the next
    // tick retries the same rows — the window is still open for one more.
    console.error('[unstaffedPostWarning] Cron error:', err);
  } finally {
    if (claimedCount > 0) {
      console.log(
        `[unstaffedPostWarning] claimed=${claimedCount} companies=${companies} ` +
        `emails_sent=${sent} released=${released} no_admins=${noAdmins}`,
      );
    }
  }
}, { sentryMonitor: false });
