/**
 * Chat retention — delete messages older than 48 hours.
 * Runs every hour.
 */
import { runJob } from './_run';
import { pool } from '../db/pool';

runJob('chatRetention', '0 * * * *', async () => {
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
}, { sentryMonitor: true });
