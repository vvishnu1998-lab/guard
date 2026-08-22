/**
 * Offline Queue — persists unsynced actions to device storage and replays
 * them in order when connectivity is restored.
 *
 * Covered action types:
 *   report_submit   — activity / incident / maintenance reports
 *   checkpoint_scan — patrol tag scans
 *   task_complete   — DEAD CODE: offlineStore.completeTask has no consumers;
 *                     tasks submit via apiClient directly. Type retained so
 *                     items persisted by older builds still resolve.
 *   violation_post  — DEAD CODE: offlineStore.postViolation has no consumers;
 *                     tasks/locationBackground.ts posts violations with a raw
 *                     fetch, outside this queue entirely. Same retention note.
 *
 * Design decisions:
 *   - Queue is stored in AsyncStorage as a JSON array (no native SQLite dep needed)
 *   - Items are keyed by a local UUID so the UI can reference them optimistically
 *   - An item that cannot be delivered moves to a dead-letter bucket recording
 *     WHY (permanent_4xx / max_attempts / unknown_type), and the guard is shown
 *     a banner. That last clause was documented here and NOT IMPLEMENTED from
 *     the day this file shipped until 2026-08-22: nothing read the bucket, so
 *     every abandoned write vanished silently after the UI said it was saved.
 *   - Sync runs: on app foreground, on network reconnect, and every 60 s while active
 *   - Items are processed strictly in FIFO order
 *
 * NOT covered: location pings. app/ping/photo.tsx posts them directly and
 * surfaces failures to the guard. See the note on that file for why
 * queueing them needs a schema change first, not just idempotency.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { apiClient, ApiError, SessionExpiredError } from './apiClient';

/** RFC-4122 v4 UUID — Math.random-based, safe in Hermes (no crypto.getRandomValues needed) */
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const QUEUE_KEY      = 'guard_offline_queue';
const DEAD_LETTER_KEY = 'guard_offline_dead_letter';
const MAX_ATTEMPTS   = 5;

export type QueueActionType =
  | 'report_submit'
  | 'task_complete'
  | 'violation_post'
  | 'checkpoint_scan';

/**
 * Why an item was given up on. The review screen branches on this: a
 * network exhaustion CAN succeed if retried, a permanent 4xx never will,
 * and offering "Retry" on the latter is theatre.
 */
export type DeadReason =
  | 'permanent_4xx'   // server refused it; the frozen payload will never pass
  | 'max_attempts'    // transport failed MAX_ATTEMPTS times
  | 'unknown_type';   // persisted by a build whose action type we dropped

export interface QueuedAction {
  localId:    string;          // uuid — client-assigned, used for optimistic UI
  type:       QueueActionType;
  payload:    Record<string, unknown>;
  attempts:   number;
  queuedAt:   string;          // ISO timestamp
  lastError?: string;

  // ── dead-letter fields; absent while the item is still in the queue ───
  // All optional so items persisted by earlier builds still parse.
  deadReason?:     DeadReason;
  deadStatus?:     number;      // HTTP status, when there was one
  deadAt?:         string;      // ISO
  /** ISO once the server has acknowledged this loss. NULL/absent means the
   *  loss exists only on this handset. Deletion is gated on this — see
   *  deleteDeadLetter. */
  reportedAt?:     string | null;
  reportAttempts?: number;
  /** ISO when the guard dismissed the banner for this item. It stays in
   *  storage and stays eligible for reporting; this only hides it. */
  acknowledgedAt?: string | null;
}

// ── Queue read/write ─────────────────────────────────────────────────────────

async function readQueue(): Promise<QueuedAction[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as QueuedAction[]) : [];
}

async function writeQueue(queue: QueuedAction[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  notifyChange();
}

async function readDeadLetter(): Promise<QueuedAction[]> {
  const raw = await AsyncStorage.getItem(DEAD_LETTER_KEY);
  return raw ? (JSON.parse(raw) as QueuedAction[]) : [];
}

async function writeDeadLetter(dead: QueuedAction[]): Promise<void> {
  await AsyncStorage.setItem(DEAD_LETTER_KEY, JSON.stringify(dead));
  notifyChange();
}

async function moveToDeadLetter(
  item: QueuedAction,
  reason: DeadReason,
  status?: number,
): Promise<void> {
  const dead = await readDeadLetter();
  dead.push({
    ...item,
    deadReason: reason,
    deadStatus: status,
    deadAt: new Date().toISOString(),
    reportedAt: null,
    reportAttempts: 0,
    acknowledgedAt: null,
  });
  await writeDeadLetter(dead);
  console.warn(
    `[offline-queue] DEAD-LETTER ${item.type}:${item.localId} reason=${reason}` +
    `${status ? ` status=${status}` : ''} after ${item.attempts} attempt(s)`,
  );
}

// ── Change notification ──────────────────────────────────────────────────
// The queue stays free of any UI dependency; offlineStore subscribes and
// re-reads the counts. Without this the banner would only update on the
// screens that happen to remount.
type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/** Subscribe to queue/dead-letter changes. Returns an unsubscribe fn. */
export function onQueueChange(fn: ChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyChange(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.warn('[offline-queue] listener threw:', err); }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Add an action to the queue. Returns the localId for optimistic UI binding. */
export async function enqueue(
  type: QueueActionType,
  payload: Record<string, unknown>
): Promise<string> {
  const localId = uuidv4();
  const item: QueuedAction = {
    localId,
    type,
    payload,
    attempts: 0,
    queuedAt: new Date().toISOString(),
  };
  const queue = await readQueue();
  queue.push(item);
  await writeQueue(queue);
  console.log(`[offline-queue] Enqueued ${type} (${localId}). Queue length: ${queue.length}`);
  return localId;
}

/** Remove a successfully synced item by localId */
async function dequeue(localId: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((i) => i.localId !== localId));
}

/** How many items are waiting to sync */
export async function pendingCount(): Promise<number> {
  const queue = await readQueue();
  return queue.length;
}

// ── Sync logic ────────────────────────────────────────────────────────────────

const ENDPOINT: Record<QueueActionType, string> = {
  report_submit:   '/reports',
  task_complete:   '/tasks/instances/{id}/complete',
  violation_post:  '/locations/violation',
  // Payload carries the GPS captured AT SCAN TIME; a replay that already
  // landed is absorbed by the server's round-window ON CONFLICT (200).
  checkpoint_scan: '/checkpoints/scan',
};

type SyncResult =
  | { outcome: 'success' }
  | { outcome: 'retry' }
  | { outcome: 'dead'; reason: DeadReason; status?: number };

async function syncItem(item: QueuedAction): Promise<SyncResult> {
  try {
    let path = ENDPOINT[item.type];
    // Unknown type — a queue item persisted by an older build whose action
    // type this build no longer handles. Dead-letter immediately rather
    // than POSTing to `undefined` five times.
    if (!path) {
      console.warn(`[offline-queue] unknown action type ${item.type} — dead-lettering`);
      return { outcome: 'dead', reason: 'unknown_type' };
    }

    // task_complete needs the instance id interpolated into the path
    if (item.type === 'task_complete' && item.payload.task_instance_id) {
      path = `/tasks/instances/${item.payload.task_instance_id}/complete`;
    }

    await apiClient.post(path, item.payload);
    return { outcome: 'success' };
  } catch (err: any) {
    const newAttempts = item.attempts + 1;
    console.error(`[offline-queue] syncItem failed (attempt ${newAttempts}/${MAX_ATTEMPTS}):`, err?.message, 'payload:', JSON.stringify(item.payload).slice(0, 400));
    const queue = await readQueue();
    const idx = queue.findIndex((i) => i.localId === item.localId);
    if (idx !== -1) {
      queue[idx].attempts  = newAttempts;
      queue[idx].lastError = err?.message ?? 'Unknown error';
      await writeQueue(queue);
    }
    // A permanent 4xx will NEVER succeed on replay — the payload is frozen
    // in AsyncStorage at enqueue time and cannot change. Retrying it four
    // more times burns requests, delays the dead-letter alert the guard
    // needs to see, and (for 422 MOCK_LOCATION_REJECTED) emits four extra
    // mock.reject lines for one event, polluting the exact signal we are
    // measuring. Dead-letter it immediately.
    //
    // SessionExpiredError is the deliberate exception: it is an ApiError,
    // but the session CAN be restored by logging back in, so the item must
    // survive rather than be discarded.
    //
    // Network failures and 5xx keep the retry budget — those are transient.
    if (err instanceof ApiError && !(err instanceof SessionExpiredError)
        && err.status >= 400 && err.status < 500) {
      console.error(`[offline-queue] permanent ${err.status} (${err.code ?? 'no code'}) — dead-lettering without retry`);
      return { outcome: 'dead', reason: 'permanent_4xx', status: err.status };
    }
    if (newAttempts >= MAX_ATTEMPTS) return { outcome: 'dead', reason: 'max_attempts' };
    return { outcome: 'retry' };
  }
}

/**
 * Tell the server about losses it does not know about yet.
 *
 * ── WHY THIS IS NOT A QUEUE ─────────────────────────────────────────────
 *
 * The obvious implementation — enqueue() the escalation — rebuilds the hole
 * one layer up: a failed escalation would be dead-lettered, producing
 * another escalation, which can also fail. So this is a FLAG on state that
 * already exists (reportedAt / reportAttempts), swept by the timer that
 * already runs. No new persistence, no new failure mode.
 *
 * ── FAILURE IS INERT ────────────────────────────────────────────────────
 *
 * If this never succeeds, nothing is lost and nothing is hidden: the item
 * stays in the bucket, the banner still shows it, and deleteDeadLetter()
 * still refuses. A failed escalation degrades to "device-only record",
 * which is strictly better than the silence it replaced — never worse.
 *
 * The banner deliberately does NOT depend on this. Guard awareness must
 * not require connectivity, because bad connectivity is what causes most
 * of these losses in the first place.
 */
const MAX_REPORT_ATTEMPTS = 10;
const REPORT_BATCH        = 20;   // server caps at 20 too; it is authoritative

async function bumpAttempts(ids: Set<string>, reportedAt: string | null): Promise<void> {
  const fresh = await readDeadLetter();
  for (const i of fresh) {
    if (!ids.has(i.localId)) continue;
    if (reportedAt) i.reportedAt = reportedAt;
    else i.reportAttempts = (i.reportAttempts ?? 0) + 1;
  }
  await writeDeadLetter(fresh);
}

export async function reportDeadLetters(): Promise<void> {
  const dead = await readDeadLetter();
  const pending = dead.filter(
    (i) => !i.reportedAt && (i.reportAttempts ?? 0) < MAX_REPORT_ATTEMPTS,
  );
  if (pending.length === 0) return;

  // One batched request per sweep, never one per item. A device with a
  // backlog drains over successive 60 s ticks instead of firing the whole
  // thing at the API at once.
  const batch = pending.slice(0, REPORT_BATCH);
  const ids   = new Set(batch.map((i) => i.localId));

  try {
    const res = await apiClient.post<{ accepted?: string[] }>('/offline/dead-letter', {
      items: batch.map((i) => ({
        local_id:    i.localId,
        action_type: i.type,
        dead_reason: i.deadReason ?? 'max_attempts',
        dead_status: i.deadStatus,
        queued_at:   i.queuedAt,
        dead_at:     i.deadAt,
        last_error:  i.lastError,
        payload:     i.payload,
      })),
    });
    // Mark ONLY what the server acknowledged. A partial accept leaves the
    // rest pending for the next sweep rather than losing them.
    const ok = new Set(res?.accepted ?? []);
    await bumpAttempts(new Set([...ids].filter((id) => ok.has(id))), new Date().toISOString());
    const missed = new Set([...ids].filter((id) => !ok.has(id)));
    if (missed.size) await bumpAttempts(missed, null);
    console.log(`[offline-queue] reported ${ok.size}/${batch.length} dead-letter item(s)`);
  } catch (err: any) {
    // Deliberately swallowed. This must never surface to a guard and must
    // never be retried through the queue.
    await bumpAttempts(ids, null);
    console.warn(`[offline-queue] dead-letter report failed (not queued):`, err?.message);
  }
}

let isSyncing = false;

/** Process the entire queue. Called on reconnect / foreground / interval. */
export async function syncQueue(): Promise<void> {
  if (isSyncing) return;

  // NetInfo.isConnected is unreliable on iOS simulator — always attempt sync.
  // If the server is unreachable, the fetch will fail and the item stays in queue.

  isSyncing = true;
  try {
    const queue = await readQueue();
    if (queue.length > 0) {
      console.log(`[offline-queue] Syncing ${queue.length} queued action(s)`);

      for (const item of queue) {
        const result = await syncItem(item);
        if (result.outcome === 'success') {
          await dequeue(item.localId);
          console.log(`[offline-queue] ✓ Synced ${item.type}:${item.localId}`);
        } else if (result.outcome === 'dead') {
          // Re-read: syncItem's catch wrote the incremented attempts and
          // lastError back to storage, so the loop's copy is stale.
          const fresh = (await readQueue()).find((i) => i.localId === item.localId) ?? item;
          await dequeue(item.localId);
          await moveToDeadLetter(fresh, result.reason, result.status);
        }
        // 'retry' → stays in queue, will be retried on next sync
      }
    }

    // Escalate losses even when the queue is empty. The dead-letter bucket
    // outlives the queue, and "nothing pending, something lost" is the
    // normal state — an early return here would mean the server was only
    // ever told while the guard happened to have other work in flight.
    await reportDeadLetters();
  } finally {
    isSyncing = false;
  }
}

// ── Network listener ──────────────────────────────────────────────────────────

let unsubscribeNetInfo: (() => void) | null = null;
let syncInterval: ReturnType<typeof setInterval> | null = null;

/** Call once on shift start. Registers network listener + 60s polling. */
export function startQueueSync(): void {
  // Sync immediately on register
  syncQueue();

  // Sync on every reconnect
  unsubscribeNetInfo = NetInfo.addEventListener((state) => {
    if (state.isConnected) syncQueue();
  });

  // Sync every 60 s as a belt-and-suspenders fallback
  syncInterval = setInterval(syncQueue, 60_000);
  console.log('[offline-queue] Sync started');
}

/** Call on clock-out or logout. */
export function stopQueueSync(): void {
  unsubscribeNetInfo?.();
  unsubscribeNetInfo = null;
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  console.log('[offline-queue] Sync stopped');
}

// ── Dead letter: the record of writes that will never land ───────────────
//
// Until 2026-08-22 this bucket was written to and READ BY NOTHING.
// getDeadLetterItems() and clearDeadLetter() had zero call sites and no
// screen rendered the count, so every abandoned write since the queue
// shipped disappeared in silence — after the UI had told the guard it was
// saved. That is what this section exists to end.

/** Every dead-letter item, newest first. Includes acknowledged ones. */
export async function getDeadLetterItems(): Promise<QueuedAction[]> {
  const dead = await readDeadLetter();
  return dead.slice().reverse();
}

/**
 * How many losses the guard has not yet dismissed. This is the banner's
 * number — it deliberately ignores whether the server knows, because guard
 * awareness must not depend on connectivity.
 */
export async function deadLetterCount(): Promise<number> {
  const dead = await readDeadLetter();
  return dead.filter((i) => !i.acknowledgedAt).length;
}

/**
 * Dismiss the banner for one item. DOES NOT DELETE IT.
 *
 * The item stays in storage and stays eligible for reporting to the
 * server. A guard can silence the warning; they cannot make the loss
 * disappear before anyone upstream has learned of it. Deleting on dismiss
 * would rebuild the exact hole this whole surface exists to close.
 */
export async function acknowledgeDeadLetter(localId: string): Promise<void> {
  const dead = await readDeadLetter();
  const idx = dead.findIndex((i) => i.localId === localId);
  if (idx === -1) return;
  dead[idx].acknowledgedAt = new Date().toISOString();
  await writeDeadLetter(dead);
}

/**
 * Permanently remove an item. GATED ON reportedAt: an item the server has
 * never heard about cannot be deleted from the handset, because this is
 * then the only record that it happened.
 *
 * Returns false when the gate refuses.
 */
export async function deleteDeadLetter(localId: string): Promise<boolean> {
  const dead = await readDeadLetter();
  const item = dead.find((i) => i.localId === localId);
  if (!item) return true;
  if (!item.reportedAt) {
    console.warn(`[offline-queue] refusing to delete unreported ${item.type}:${localId}`);
    return false;
  }
  await writeDeadLetter(dead.filter((i) => i.localId !== localId));
  return true;
}

/** Re-queue a dead-lettered item. Only meaningful for 'max_attempts' —
 *  a permanent 4xx will be refused identically, because the payload was
 *  frozen at enqueue time and cannot change. */
export async function retryDeadLetter(localId: string): Promise<void> {
  const dead = await readDeadLetter();
  const item = dead.find((i) => i.localId === localId);
  if (!item) return;
  await writeDeadLetter(dead.filter((i) => i.localId !== localId));
  const queue = await readQueue();
  queue.push({
    localId: item.localId,
    type: item.type,
    payload: item.payload,
    attempts: 0,
    queuedAt: item.queuedAt,
  });
  await writeQueue(queue);
  syncQueue().catch(console.error);
}
