import { create } from 'zustand';
import * as Sentry from '@sentry/react-native';
import { setShiftTag } from '../lib/sentry';
import { apiClient } from '../lib/apiClient';
import { useUnreadStore } from './unreadStore';

interface Geofence {
  polygon_coordinates: { lat: number; lng: number }[];
  center_lat: number;
  center_lng: number;
  radius_meters: number;
}

interface Shift {
  id: string;
  site_id: string;
  site_name: string;
  scheduled_start: string;
  scheduled_end: string;
  instructions_pdf_url?: string | null;
  effective_photo_limit?: number;
  /** Per-site ping cadence in minutes. Set from sites.ping_interval_minutes
   *  at active-session restore / clock-in. Optional on the wire for
   *  backwards compat with pre-Item-8 API responses; consumers should
   *  fall back to 30 when absent. */
  ping_interval_minutes?: number;
  geofence?: Geofence;
}

interface ShiftSession {
  id: string;
  shift_id: string;
  clocked_in_at: string;
}

interface ShiftState {
  pendingShift: Shift | null;
  activeShift: Shift | null;
  activeSession: ShiftSession | null;
  setPendingShift: (shift: Shift) => void;
  setActiveSession: (shift: Shift, session: ShiftSession) => void;
  clearSession: () => void;
  /** Reconcile cached server-derived state with the server. Non-throwing:
   *  see the body comment for the drift scenarios and the silent-fail
   *  semantics. */
  refreshFromServer: () => Promise<void>;
}

export const useShiftStore = create<ShiftState>((set, get) => ({
  pendingShift: null,
  activeShift: null,
  activeSession: null,

  setPendingShift: (shift) => set({ pendingShift: shift }),

  setActiveSession: (shift, session) => {
    set({ activeShift: shift, activeSession: session, pendingShift: null });
    setShiftTag(session.id);
  },

  clearSession: () => {
    set({ activeShift: null, activeSession: null, pendingShift: null });
    setShiftTag(null);
  },

  // Walk-test 2026-07-10 BUG H tail. Build 30 wired clearSession() into
  // both the foreground push receiver (_layout.tsx addNotificationReceived
  // Listener) and the tap handler (navigateForNotification.ts). Neither
  // fires when the push arrives while the app is backgrounded AND the
  // user later opens the app via the icon (dismissing or ignoring the OS
  // banner). In that path the cached activeSession stays intact and home
  // keeps showing SHIFT ACTIVE + CLOCK OUT for a session that no longer
  // exists server-side.
  //
  // Called from:
  //   - AppState 'active' transition in _layout.tsx (throttled to 2s to
  //     absorb iOS Control Center swipes that fire background↔active
  //     transitions on every pane change).
  //   - useFocusEffect on the home tab in (tabs)/home.tsx (covers the
  //     intra-app case where the guard was on a different tab when the
  //     drift happened and returns to home without a background trip).
  //
  // Silent-fail semantics (per spec 2026-07-10):
  //   - Server 200 with body === null → cache had activeSession → clear.
  //   - Server 200 with body → intentionally NO-OP on activeShift (see
  //     below); we only ever clear from this method.
  //   - Server 5xx / network error → KEEP cached state. A stray refetch
  //     failure during a subway ride must not tear down an in-progress
  //     shift's Live Map + Ping Countdown. Breadcrumb only, retry on next
  //     AppState 'active' or home focus.
  //
  // Why we don't setActiveSession on positive server response:
  //   /shifts/active-session returns shift metadata WITHOUT the site
  //   geofence (that's on /shifts/:id). Overwriting activeShift here
  //   would drop the geofence that home.handleClockIn hydrated at
  //   clock-in time, which would in turn make the _layout.tsx background
  //   geofence effect (activeSession && activeShift?.geofence) tear down
  //   monitoring. This method is deliberately narrow: it only reconciles
  //   the "session ended while we weren't looking" drift.
  //
  // Also refreshes inbound-invite state via unreadStore.refresh(): that
  // hits /shifts/inbound-swap-requests and rewrites the ALERTS badge
  // count. Without this leg, a handoff invite that arrived during
  // background would leave the ALERTS badge stale (the alerts.tsx tab
  // list itself has its own useFocusEffect so opening the tab still
  // works — but the badge that tells the guard to open the tab wouldn't
  // update until they did something else that triggered a refresh).
  refreshFromServer: async () => {
    try {
      const active = await apiClient.get<{ session: { id: string } } | null>('/shifts/active-session');
      const state = get();
      if (!active && state.activeSession) {
        set({ activeShift: null, activeSession: null, pendingShift: null });
        setShiftTag(null);
        Sentry.addBreadcrumb({
          category: 'session_refresh',
          message: 'server returned null — cleared cached session',
          level: 'info',
          data: { had_session_id: state.activeSession.id },
        });
      }
    } catch (err: any) {
      Sentry.addBreadcrumb({
        category: 'session_refresh',
        message: 'error — kept cached state',
        level: 'warning',
        data: { error: err?.message ?? String(err) },
      });
    }
    // Inbound-invite leg. Fires independently of the active-session leg
    // outcome so a session-fetch failure doesn't also silence badge
    // updates. unreadStore.refresh() has its own try/catch and Sentry
    // capture — no need to double-wrap here.
    useUnreadStore.getState().refresh();
  },
}));
