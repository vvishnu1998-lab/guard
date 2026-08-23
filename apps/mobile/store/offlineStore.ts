/**
 * Offline-aware action store.
 *
 * Guards call submitReport / completeTask from anywhere in the app.
 * Each method:
 *   1. Always tries to POST immediately (no NetInfo gate — NetInfo is unreliable on iOS simulator)
 *   2. Falls back to enqueue() only if the online POST throws
 *   3. After enqueueing, immediately tries to sync so queued items flush as fast as possible
 *   4. Returns a localId so the UI can show optimistic state instantly
 *
 * The queue also syncs automatically via startQueueSync() / stopQueueSync()
 * which are called from the shift lifecycle (clock-in → clock-out).
 */

import { create } from 'zustand';
import * as Sentry from '@sentry/react-native';
import { apiClient, ApiError } from '../lib/apiClient';
import {
  enqueue, pendingCount, startQueueSync, stopQueueSync, syncQueue,
  deadLetterCounts, onQueueChange, quarantineCount,
} from '../lib/offlineQueue';
import type { SubmitReportRequest, GeofenceViolationRequest } from '@guard/shared';

/**
 * Only network / DNS / 5xx failures should fall into the offline queue.
 * A 4xx from the server means the request is invalid AS-SENT (off-post,
 * bad payload, expired session) — queueing it would just spin retries
 * forever against a payload the server will always reject.
 *
 * ApiError with status < 500 → re-throw so the UI can react.
 * Anything else (native fetch reject, 5xx, timeout) → fall through to
 * the caller's enqueue path.
 */
function shouldSurfaceInsteadOfQueue(err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    Sentry.addBreadcrumb({
      category: 'offlineStore',
      message: `4xx surfaced — not queued (status=${err.status} code=${err.code ?? 'none'})`,
      level: 'info',
    });
    return true;
  }
  return false;
}

interface OfflineState {
  pendingCount: number;
  /** Losses the guard has not dismissed. Drives the banner. Read from
   *  AsyncStorage, so it survives force-quit, cold start and logout — only
   *  an uninstall clears it. */
  deadCount: number;
  /** Every dead-letter item, dismissed or not. The drawer row uses this so
   *  it can stay reachable after a dismissal. */
  deadTotal: number;
  /** Items the server has not acknowledged. A dismissed one of these is a
   *  loss nobody upstream knows about. */
  deadUnreported: number;
  /** True once this device has quarantined a corrupt bucket. Those writes
   *  are preserved but unreadable, so they may never have been sent — the
   *  guard has to be told rather than left to assume. */
  storageDegraded: boolean;
  refreshPendingCount: () => Promise<void>;
  refreshCounts: () => Promise<void>;
  startSync: () => void;
  stopSync:  () => void;

  submitReport:   (payload: SubmitReportRequest)      => Promise<{ synced: true; data: any } | { synced: false; localId: string }>;
  completeTask:   (taskInstanceId: string, payload: Record<string, unknown>) => Promise<string>;
  postViolation:  (payload: GeofenceViolationRequest)  => Promise<string>;
  submitCheckpointScan: (payload: {
    code_value: string; latitude: number; longitude: number; accuracy?: number; note?: string;
  }) => Promise<{ synced: true; data: any } | { synced: false; localId: string }>;
}

export const useOfflineStore = create<OfflineState>((set) => ({
  pendingCount: 0,
  deadCount: 0,
  deadTotal: 0,
  deadUnreported: 0,
  storageDegraded: false,

  refreshPendingCount: async () => {
    const count = await pendingCount();
    set({ pendingCount: count });
  },

  refreshCounts: async () => {
    const [pending, dead, quarantined] = await Promise.all([
      pendingCount(), deadLetterCounts(), quarantineCount(),
    ]);
    set({
      pendingCount:    pending,
      deadCount:       dead.unacknowledged,
      deadTotal:       dead.total,
      deadUnreported:  dead.unreported,
      storageDegraded: quarantined > 0,
    });
  },

  startSync: () => startQueueSync(),
  stopSync:  () => stopQueueSync(),

  submitReport: async (payload) => {
    try {
      const data = await apiClient.post<any>('/reports', payload);
      return { synced: true, data };
    } catch (err: any) {
      if (shouldSurfaceInsteadOfQueue(err)) throw err;
      console.error('[submitReport] Direct submit failed, queuing:', err?.message, JSON.stringify(payload).slice(0, 150));
    }

    const localId = await enqueue('report_submit', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    syncQueue().catch(console.error);
    return { synced: false, localId };
  },

  completeTask: async (taskInstanceId, payload) => {
    const body = { ...payload, task_instance_id: taskInstanceId };
    try {
      await apiClient.post(`/tasks/instances/${taskInstanceId}/complete`, payload);
      return 'synced';
    } catch (err) {
      if (shouldSurfaceInsteadOfQueue(err)) throw err;
    }

    const localId = await enqueue('task_complete', body);
    const count = await pendingCount();
    set({ pendingCount: count });
    syncQueue().catch(console.error);
    return localId;
  },

  // C6 — checkpoint scans. 4xx (404 unknown tag / 422 too far / 403 no
  // session) surfaces to the scanner UI; only network/5xx failures queue.
  // The payload's coords were captured at scan time, so a queued replay
  // validates against where the guard actually stood.
  submitCheckpointScan: async (payload) => {
    try {
      const data = await apiClient.post<any>('/checkpoints/scan', payload);
      return { synced: true, data };
    } catch (err) {
      if (shouldSurfaceInsteadOfQueue(err)) throw err;
      console.error('[submitCheckpointScan] Direct submit failed, queuing:', (err as any)?.message);
    }
    const localId = await enqueue('checkpoint_scan', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    syncQueue().catch(console.error);
    return { synced: false, localId };
  },

  postViolation: async (payload) => {
    try {
      await apiClient.post('/locations/violation', payload);
      return 'synced';
    } catch (err) {
      if (shouldSurfaceInsteadOfQueue(err)) throw err;
    }

    const localId = await enqueue('violation_post', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    syncQueue().catch(console.error);
    return localId;
  },
}));

// The queue mutates from a 60 s timer, a NetInfo listener and every submit
// path. Subscribing here means the banner reacts wherever the guard is,
// rather than only on screens that happen to remount.
onQueueChange(() => {
  void useOfflineStore.getState().refreshCounts();
});
