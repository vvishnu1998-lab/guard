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

// ── Phase 2: mid-shift handoff pushes ────────────────────────────────────
// Distinct `type` strings from the pre-shift swap helpers so mobile's
// navigateForNotification can route handoffs to their own cards + flows
// (handoff invites need to open a travel-and-clock-in path, not a passive
// accept card).

function fmtTimeAt(dt: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: tz,
  }).format(new Date(dt));
}

/** To recipient B: A wants B to take over the currently-active shift. */
export async function pushHandoffRequestToRecipient(params: {
  toGuardId:      string;
  fromGuardName:  string;
  siteName:       string;
  siteTz:         string | null;
  scheduledEnd:   Date | string;
  shiftId:        string;
  historyId:      string;
}): Promise<void> {
  const tz = params.siteTz ?? PACIFIC;
  const endsAt = fmtTimeAt(params.scheduledEnd, tz);
  return fireOne(
    params.toGuardId,
    `Handoff request from ${params.fromGuardName}`,
    `${params.fromGuardName} needs you to cover the rest of their shift at ${params.siteName} (until ${endsAt}). Tap to view.`,
    { type: 'handoff_request_received', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** Confirmation to requester A when the handoff invite is sent. */
export async function pushHandoffRequestSentToRequester(params: {
  fromGuardId:  string;
  toGuardName:  string;
  siteName:     string;
  shiftId:      string;
  historyId:    string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    'Handoff request sent',
    `Waiting for ${params.toGuardName} to accept taking over your shift at ${params.siteName}. Stay clocked in.`,
    { type: 'handoff_request_sent', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To requester A when B accepts — A must stay on-post until B arrives. */
export async function pushHandoffAcceptedToRequester(params: {
  fromGuardId: string;
  toGuardName: string;
  shiftId:     string;
  historyId:   string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    `${params.toGuardName} accepted your handoff`,
    `${params.toGuardName} is on the way. Stay clocked in until they arrive on-site.`,
    { type: 'handoff_accepted', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To requester A when B declines the handoff invite. */
export async function pushHandoffDeclinedToRequester(params: {
  fromGuardId: string;
  toGuardName: string;
  shiftId:     string;
  historyId:   string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    `${params.toGuardName} declined your handoff`,
    'Try another guard, or contact admin.',
    { type: 'handoff_declined', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To the other party (whoever didn't cancel) when a handoff is cancelled
 *  after acceptance but before arrival. */
export async function pushHandoffCancelled(params: {
  toGuardId:      string;
  cancellerName:  string;
  siteName:       string;
  shiftId:        string;
  historyId:      string;
}): Promise<void> {
  return fireOne(
    params.toGuardId,
    'Handoff cancelled',
    `${params.cancellerName} cancelled the handoff for ${params.siteName}.`,
    { type: 'handoff_cancelled', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To requester A once B physically clocks in — A is now clocked out. */
export async function pushHandoffCompleteToRequester(params: {
  fromGuardId:  string;
  toGuardName:  string;
  shiftId:      string;
  historyId:    string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    'Handoff complete',
    `${params.toGuardName} has taken over. You are now clocked out.`,
    { type: 'handoff_complete', shift_id: params.shiftId, history_id: params.historyId },
  );
}

/** To either party by the nudge cron: accepted but no arrival yet. */
export async function pushHandoffNudge(params: {
  guardId:      string;
  role:         'from' | 'to';
  otherName:    string;
  siteName:     string;
  shiftId:      string;
  historyId:    string;
  minutesLate:  number;
}): Promise<void> {
  const title = 'Handoff still pending arrival';
  const body  = params.role === 'to'
    ? `You accepted a handoff for ${params.siteName} ${params.minutesLate} min ago but haven't clocked in yet. Travel to the site and clock in.`
    : `${params.otherName} accepted your handoff ${params.minutesLate} min ago but hasn't clocked in yet. You're still on shift.`;
  return fireOne(
    params.guardId,
    title,
    body,
    { type: 'handoff_nudge', shift_id: params.shiftId, history_id: params.historyId, role: params.role },
  );
}

/** To recipient B when the cron marks their accepted-but-not-clocked-in
 *  handoff (or the nudge cap is exceeded and it's force-cancelled). Used
 *  only if we ever wire timeout-cancel; for now the shared expiry cron
 *  handles pending, not accepted. Included here for symmetry with the
 *  pre-shift `pushSwapExpiredToRequester`. */
export async function pushHandoffExpiredToRequester(params: {
  fromGuardId: string;
  siteName:    string;
  shiftId:     string;
  historyId:   string;
}): Promise<void> {
  return fireOne(
    params.fromGuardId,
    'Handoff request expired',
    `Nobody accepted your handoff for ${params.siteName}. Contact admin.`,
    { type: 'handoff_expired', shift_id: params.shiftId, history_id: params.historyId },
  );
}
