/**
 * Guard-to-guard shift swap push helpers.
 *
 * Each fires one push to one guard for a single event — no aggregation
 * needed (swaps are single-actor events). Each wraps sendPushNotification
 * and handles stale-token cleanup the same way shiftPush.ts /
 * fireBreachAlerts does.
 *
 * All errors are caught inside the helper; callers safely fire-and-forget
 * with `.catch()` on the returned promise.
 */
import { pool } from '../db/pool';
import { sendPushNotification } from './firebase';

const PACIFIC = 'America/Los_Angeles';

function fmtDayAt(dt: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: tz,
  }).format(new Date(dt));
}

async function fireOne(
  guardId: string,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<void> {
  try {
    const tokRow = await pool.query<{ fcm_token: string | null }>(
      'SELECT fcm_token FROM guards WHERE id = $1',
      [guardId],
    );
    const token = tokRow.rows[0]?.fcm_token;
    if (!token) return;
    const { staleToken } = await sendPushNotification({ token, title, body, data });
    if (staleToken) {
      await pool.query(
        'UPDATE guards SET fcm_token = NULL WHERE id = $1 AND fcm_token = $2',
        [guardId, token],
      );
    }
  } catch (err) {
    console.error('[swap-push] failed for guard', guardId, err);
  }
}

/** To the recipient (B) when a swap invitation is created. */
export async function pushSwapRequestToRecipient(params: {
  toGuardId:      string;
  fromGuardName:  string;
  siteName:       string;
  siteTz:         string | null;
  scheduledStart: Date | string;
  shiftId:        string;
  historyId:      string;
}): Promise<void> {
  const tz = params.siteTz ?? PACIFIC;
  const day = fmtDayAt(params.scheduledStart, tz);
  return fireOne(
    params.toGuardId,
    `Swap request from ${params.fromGuardName}`,
    `${params.fromGuardName} wants you to cover their shift at ${params.siteName} on ${day}. Tap to view.`,
    { type: 'swap_request_received', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To the requester (A) — confirmation the invitation was sent. */
export async function pushSwapRequestSentToRequester(params: {
  fromGuardId:   string;
  toGuardName:   string;
  siteName:      string;
  shiftId:       string;
  historyId:     string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    'Swap request sent',
    `Waiting for ${params.toGuardName} to accept covering your shift at ${params.siteName}.`,
    { type: 'swap_request_sent', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To the requester (A) when B accepts. */
export async function pushSwapAcceptedToRequester(params: {
  fromGuardId: string;
  toGuardName: string;
  shiftId:     string;
  historyId:   string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    `${params.toGuardName} accepted your swap`,
    'Shift transferred. Check your schedule.',
    { type: 'swap_accepted', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To the requester (A) when B declines. */
export async function pushSwapDeclinedToRequester(params: {
  fromGuardId: string;
  toGuardName: string;
  shiftId:     string;
  historyId:   string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    `${params.toGuardName} declined your swap request`,
    'Try another guard, or contact admin.',
    { type: 'swap_declined', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To the requester (A) when the cron marks their pending request 'expired'. */
export async function pushSwapExpiredToRequester(params: {
  fromGuardId: string;
  siteName:    string;
  shiftId:     string;
  historyId:   string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    'Swap request expired',
    `Nobody accepted your swap for ${params.siteName}. Contact admin.`,
    { type: 'swap_expired', shift_id: params.shiftId, history_id: params.historyId },
  );
}
