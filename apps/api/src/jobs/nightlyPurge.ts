/**
 * Nightly purge — runs at 00:00 UTC (Section 11.2)
 *
 * Five independent operations, in order:
 *  1. Delete location_ping photos older than 7 days (skip retain_as_evidence = true)
 *  2. Disable client/Star access at day 90 and update sites.client_access_disabled_at
 *  3. Send Vishnu email warning at day 140 (10 days before deletion)
 *  4. Hard-delete all operational data for sites past day 150
 *  5. Delete notification rows older than 30 days
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { deleteS3Object } from '../services/s3';
import { sendVishnu140DayWarning } from '../services/email';

cron.schedule('0 0 * * *', async () => {
  console.log('[nightly-purge] Starting at', new Date().toISOString());

  // ── Step 1: Delete expired ping photos ───────────────────────────────────
  // Skips pings marked retain_as_evidence (open geofence violation evidence).
  const expiredPings = await pool.query(
    `SELECT id, photo_url FROM location_pings
     WHERE photo_url IS NOT NULL
       AND photo_delete_at < NOW()
       AND retain_as_evidence = false`,
  );

  let deletedPhotos = 0;
  for (const ping of expiredPings.rows) {
    try {
      await deleteS3Object(ping.photo_url);
      await pool.query('UPDATE location_pings SET photo_url = NULL WHERE id = $1', [ping.id]);
      deletedPhotos++;
    } catch (err) {
      console.error('[nightly-purge] Failed to delete ping photo', ping.id, err);
    }
  }
  console.log(`[nightly-purge] Step 1: Purged ${deletedPhotos} ping photos`);

  // ── Step 2: Disable client/Star access at day 90 ─────────────────────────
  const expiredAccess = await pool.query(
    `UPDATE data_retention_log
     SET client_star_access_disabled = true
     WHERE client_star_access_until < NOW()
       AND client_star_access_disabled = false
     RETURNING site_id`,
  );

  for (const row of expiredAccess.rows) {
    await Promise.all([
      // Deactivate the client portal account
      pool.query('UPDATE clients SET is_active = false WHERE site_id = $1', [row.site_id]),
      // Record the exact timestamp of disablement on the sites table
      pool.query(
        'UPDATE sites SET client_access_disabled_at = NOW() WHERE id = $1',
        [row.site_id],
      ),
    ]);
  }
  console.log(`[nightly-purge] Step 2: Disabled access for ${expiredAccess.rows.length} sites`);

  // ── Step 3: Vishnu day-140 warning (fires 10 days before deletion) ────────
  const approaching = await pool.query(
    `SELECT site_id, data_delete_at
     FROM data_retention_log
     WHERE data_delete_at < NOW() + INTERVAL '10 days'
       AND warning_140_sent = false
       AND data_deleted = false`,
  );

  for (const row of approaching.rows) {
    const daysRemaining = Math.ceil(
      (new Date(row.data_delete_at).getTime() - Date.now()) / 86_400_000,
    );
    try {
      await sendVishnu140DayWarning(row.site_id, daysRemaining);
      await pool.query(
        'UPDATE data_retention_log SET warning_140_sent = true WHERE site_id = $1',
        [row.site_id],
      );
      console.log(`[nightly-purge] Step 3: Sent Vishnu warning for site ${row.site_id} (${daysRemaining}d)`);
    } catch (err) {
      console.error('[nightly-purge] Step 3: Failed to send Vishnu warning for', row.site_id, err);
    }
  }

  // ── Step 4: Hard-delete all data for sites past day 150 ──────────────────
  const toDelete = await pool.query(
    `SELECT site_id FROM data_retention_log
     WHERE data_delete_at < NOW() AND data_deleted = false`,
  );

  for (const row of toDelete.rows) {
    await hardDeleteSiteData(row.site_id);
  }
  console.log(`[nightly-purge] Step 4: Hard-deleted data for ${toDelete.rows.length} sites`);

  // ── Step 5: Trim notification log to 30 days ─────────────────────────────
  const trimmed = await pool.query(
    `DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id`,
  );
  console.log(`[nightly-purge] Step 5: Trimmed ${trimmed.rowCount} old notifications`);

  console.log('[nightly-purge] Complete');
});

// ── Hard-delete helper ────────────────────────────────────────────────────────

/**
 * Deletes all operational data for a site in dependency order (Section 11.2).
 * Cleans up S3 objects first, then removes DB rows in a transaction.
 * The sites/companies/guards records are kept for audit; data_retention_log
 * is updated with data_deleted = true.
 */
async function hardDeleteSiteData(siteId: string): Promise<void> {
  const client = await pool.connect();
  try {
    // Step A: delete S3 report photos before the DB rows disappear
    const photos = await client.query(
      `SELECT rp.storage_url
       FROM report_photos rp
       JOIN reports r ON r.id = rp.report_id
       WHERE r.site_id = $1`,
      [siteId],
    );
    for (const p of photos.rows) {
      try { await deleteS3Object(p.storage_url); } catch { /* already gone */ }
    }

    // Step B: delete task completion proof photos
    const taskPhotos = await client.query(
      `SELECT tc.photo_url
       FROM task_completions tc
       JOIN task_instances ti ON ti.id = tc.task_instance_id
       WHERE ti.site_id = $1 AND tc.photo_url IS NOT NULL`,
      [siteId],
    );
    for (const p of taskPhotos.rows) {
      try { await deleteS3Object(p.photo_url); } catch { /* already gone */ }
    }

    // Step C: delete remaining ping photos (retain_as_evidence ones skipped by purge)
    const pingPhotos = await client.query(
      `SELECT photo_url FROM location_pings WHERE site_id = $1 AND photo_url IS NOT NULL`,
      [siteId],
    );
    for (const p of pingPhotos.rows) {
      try { await deleteS3Object(p.photo_url); } catch { /* already gone */ }
    }

    // Step D: DB rows — delete in dependency order inside a transaction
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM task_completions
       WHERE shift_session_id IN (SELECT id FROM shift_sessions WHERE site_id = $1)`,
      [siteId],
    );
    await client.query('DELETE FROM task_instances  WHERE site_id = $1', [siteId]);
    await client.query('DELETE FROM break_sessions  WHERE site_id = $1', [siteId]);
    await client.query('DELETE FROM geofence_violations WHERE site_id = $1', [siteId]);
    await client.query('DELETE FROM location_pings  WHERE site_id = $1', [siteId]);
    await client.query('DELETE FROM clock_in_verifications WHERE site_id = $1', [siteId]);
    await client.query(
      `DELETE FROM report_photos
       WHERE report_id IN (SELECT id FROM reports WHERE site_id = $1)`,
      [siteId],
    );
    await client.query('DELETE FROM reports         WHERE site_id = $1', [siteId]);
    await client.query('DELETE FROM shift_sessions  WHERE site_id = $1', [siteId]);
    await client.query('DELETE FROM shifts          WHERE site_id = $1', [siteId]);
    await client.query('DELETE FROM guard_site_assignments WHERE site_id = $1', [siteId]);

    // Mark as deleted — keep the DRL row for audit
    await client.query(
      'UPDATE data_retention_log SET data_deleted = true WHERE site_id = $1',
      [siteId],
    );

    await client.query('COMMIT');
    console.log(`[nightly-purge] Hard-deleted data for site ${siteId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[nightly-purge] Failed hard-delete for site ${siteId}:`, err);
  } finally {
    client.release();
  }
}
