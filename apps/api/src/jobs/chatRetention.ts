/**
 * Chat retention — delete messages older than 48 hours.
 * Runs every hour.
 */
import cron from 'node-cron';
import { pool } from '../db/pool';

cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(
      `DELETE FROM chat_messages WHERE created_at < NOW() - INTERVAL '48 hours'`
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[chat-retention] Deleted ${result.rowCount} messages older than 48h`);
    }
  } catch (err) {
    console.error('[chat-retention] Failed:', err);
  }
});
