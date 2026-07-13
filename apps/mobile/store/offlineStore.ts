/**
 * Offline-aware action store.
 *
 * Guards call submitReport / submitPing / completeTask from anywhere in the app.
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
import { enqueue, pendingCount, startQueueSync, stopQueueSync, syncQueue } from '../lib/offlineQueue';
import type { SubmitReportRequest, LocationPingRequest, GeofenceViolationRequest } from '@guard/shared';

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
  refreshPendingCount: () => Promise<void>;
  startSync: () => void;
  stopSync:  () => void;

  submitReport:   (payload: SubmitReportRequest)      => Promise<{ synced: true; data: any } | { synced: false; localId: string }>;
  submitPing:     (payload: LocationPingRequest)       => Promise<string>;
  completeTask:   (taskInstanceId: string, payload: Record<string, unknown>) => Promise<string>;
  postViolation:  (payload: GeofenceViolationRequest)  => Promise<string>;
}

export const useOfflineStore = create<OfflineState>((set) => ({
  pendingCount: 0,

  refreshPendingCount: async () => {
    const count = await pendingCount();
    set({ pendingCount: count });
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

  submitPing: async (payload) => {
    try {
      await apiClient.post('/locations/ping', payload);
      return 'synced';
    } catch (err) {
      if (shouldSurfaceInsteadOfQueue(err)) throw err;
    }

    const localId = await enqueue('location_ping', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    syncQueue().catch(console.error);
    return localId;
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
