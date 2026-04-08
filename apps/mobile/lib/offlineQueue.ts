/**
 * Offline Queue — persists unsynced actions to device storage and replays
 * them in order when connectivity is restored.
 *
 * Covered action types:
 *   report_submit   — activity / incident / maintenance reports
 *   location_ping   — GPS-only and GPS+photo pings
 *   task_complete   — task instance completions
 *   violation_post  — geofence violation notifications
 *
 * Design decisions:
 *   - Queue is stored in AsyncStorage as a JSON array (no native SQLite dep needed)
 *   - Items are keyed by a local UUID so the UI can reference them optimistically
 *   - Each item tracks attempt count — after 5 failures it is moved to a dead-letter
 *     bucket and the guard is alerted
 *   - Sync runs: on app foreground, on network reconnect, and every 60 s while active
 *   - Items are processed strictly in FIFO order (reports before pings prevents
 *     pings referencing sessions that haven't been created yet)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { apiClient } from './apiClient';

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
  | 'location_ping'
  | 'task_complete'
  | 'violation_post';

export interface QueuedAction {
  localId:    string;          // uuid — client-assigned, used for optimistic UI
  type:       QueueActionType;
  payload:    Record<string, unknown>;
  attempts:   number;
  queuedAt:   string;          // ISO timestamp
  lastError?: string;
}

// ── Queue read/write ─────────────────────────────────────────────────────────

async function readQueue(): Promise<QueuedAction[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as QueuedAction[]) : [];
}

async function writeQueue(queue: QueuedAction[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

async function moveToDeadLetter(item: QueuedAction): Promise<void> {
  const raw = await AsyncStorage.getItem(DEAD_LETTER_KEY);
  const dead: QueuedAction[] = raw ? JSON.parse(raw) : [];
  dead.push(item);
  await AsyncStorage.setItem(DEAD_LETTER_KEY, JSON.stringify(dead));
  console.warn(`[offline-queue] Moved ${item.type}:${item.localId} to dead-letter after ${item.attempts} attempts`);
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
  report_submit:  '/reports',
  location_ping:  '/locations/ping',
  task_complete:  '/tasks/instances/{id}/complete',
  violation_post: '/locations/violation',
};

async function syncItem(item: QueuedAction): Promise<'success' | 'retry' | 'dead'> {
  try {
    let path = ENDPOINT[item.type];

    // task_complete needs the instance id interpolated into the path
    if (item.type === 'task_complete' && item.payload.task_instance_id) {
      path = `/tasks/instances/${item.payload.task_instance_id}/complete`;
    }

    await apiClient.post(path, item.payload);
    return 'success';
  } catch (err: any) {
    const newAttempts = item.attempts + 1;
    const queue = await readQueue();
    const idx = queue.findIndex((i) => i.localId === item.localId);
    if (idx !== -1) {
      queue[idx].attempts  = newAttempts;
      queue[idx].lastError = err?.message ?? 'Unknown error';
      await writeQueue(queue);
    }
    if (newAttempts >= MAX_ATTEMPTS) return 'dead';
    return 'retry';
  }
}

let isSyncing = false;

/** Process the entire queue. Called on reconnect / foreground / interval. */
export async function syncQueue(): Promise<void> {
  if (isSyncing) return;

  const netState = await NetInfo.fetch();
  if (!netState.isConnected) return;

  isSyncing = true;
  try {
    const queue = await readQueue();
    if (queue.length === 0) return;

    console.log(`[offline-queue] Syncing ${queue.length} queued action(s)`);

    for (const item of queue) {
      const result = await syncItem(item);
      if (result === 'success') {
        await dequeue(item.localId);
        console.log(`[offline-queue] ✓ Synced ${item.type}:${item.localId}`);
      } else if (result === 'dead') {
        await dequeue(item.localId);
        await moveToDeadLetter(item);
      }
      // 'retry' → stays in queue, will be retried on next sync
    }
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

/** Retrieve dead-letter items so the UI can display them */
export async function getDeadLetterItems(): Promise<QueuedAction[]> {
  const raw = await AsyncStorage.getItem(DEAD_LETTER_KEY);
  return raw ? JSON.parse(raw) : [];
}

/** Clear dead-letter after guard or admin has acknowledged */
export async function clearDeadLetter(): Promise<void> {
  await AsyncStorage.removeItem(DEAD_LETTER_KEY);
}
