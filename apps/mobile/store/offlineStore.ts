/**
 * Offline-aware action store.
 *
 * Guards call submitReport / submitPing / completeTask from anywhere in the app.
 * Each method:
 *   1. Tries to POST immediately if online
 *   2. Falls back to enqueue() if offline or on network error
 *   3. Returns a localId so the UI can show optimistic state instantly
 *
 * The queue syncs automatically via startQueueSync() / stopQueueSync()
 * which are called from the shift lifecycle (clock-in → clock-out).
 */

import { create } from 'zustand';
import NetInfo from '@react-native-community/netinfo';
import { apiClient } from '../lib/apiClient';
import { enqueue, pendingCount, startQueueSync, stopQueueSync } from '../lib/offlineQueue';
import type { SubmitReportRequest, LocationPingRequest, GeofenceViolationRequest } from '@guard/shared';

interface OfflineState {
  pendingCount: number;
  refreshPendingCount: () => Promise<void>;
  startSync: () => void;
  stopSync: () => void;

  submitReport:   (payload: SubmitReportRequest)      => Promise<string>; // returns localId
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
    const net = await NetInfo.fetch();
    if (net.isConnected) {
      try {
        await apiClient.post('/reports', payload);
        return 'synced';
      } catch { /* fall through to queue */ }
    }
    const localId = await enqueue('report_submit', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    return localId;
  },

  submitPing: async (payload) => {
    const net = await NetInfo.fetch();
    if (net.isConnected) {
      try {
        await apiClient.post('/locations/ping', payload);
        return 'synced';
      } catch { /* fall through to queue */ }
    }
    const localId = await enqueue('location_ping', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    return localId;
  },

  completeTask: async (taskInstanceId, payload) => {
    const net = await NetInfo.fetch();
    const body = { ...payload, task_instance_id: taskInstanceId };
    if (net.isConnected) {
      try {
        await apiClient.post(`/tasks/instances/${taskInstanceId}/complete`, payload);
        return 'synced';
      } catch { /* fall through to queue */ }
    }
    const localId = await enqueue('task_complete', body);
    const count = await pendingCount();
    set({ pendingCount: count });
    return localId;
  },

  postViolation: async (payload) => {
    const net = await NetInfo.fetch();
    if (net.isConnected) {
      try {
        await apiClient.post('/locations/violation', payload);
        return 'synced';
      } catch { /* fall through to queue */ }
    }
    const localId = await enqueue('violation_post', payload as unknown as Record<string, unknown>);
    const count = await pendingCount();
    set({ pendingCount: count });
    return localId;
  },
}));
