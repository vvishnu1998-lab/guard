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
import { apiClient } from '../lib/apiClient';
import { enqueue, pendingCount, startQueueSync, stopQueueSync, syncQueue } from '../lib/offlineQueue';
import type { SubmitReportRequest, LocationPingRequest, GeofenceViolationRequest } from '@guard/shared';

interface OfflineState {
  pendingCount: number;
  refreshPendingCount: () => Promise<void>;
  startSync: () => void;
  stopSync:  () => void;

  submitReport:   (payload: SubmitReportRequest)      => Promise<string>; // returns localId or 'synced'
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
    // Always try online first — NetInfo.isConnected is unreliable on iOS simulator
    try {
      await apiClient.post('/reports', payload);
      return 'synced';
    } catch (err: any) {
      console.error('[submitReport] Direct submit failed, queuing:', err?.message, JSON.stringify(payload).slice(0, 150));
    }

    const localId = await enqueue('report_submit', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    // Immediately flush the queue so it doesn't sit waiting for the sync interval
    syncQueue().catch(console.error);
    return localId;
  },

  submitPing: async (payload) => {
    try {
      await apiClient.post('/locations/ping', payload);
      return 'synced';
    } catch { /* fall through to queue */ }

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
    } catch { /* fall through to queue */ }

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
    } catch { /* fall through to queue */ }

    const localId = await enqueue('violation_post', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    syncQueue().catch(console.error);
    return localId;
  },
}));
