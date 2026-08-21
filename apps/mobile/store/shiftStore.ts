import { create } from 'zustand';
import * as Sentry from '@sentry/react-native';
import { setShiftTag } from '../lib/sentry';
import { apiClient } from '../lib/apiClient';
import { persistBreakUntil, clearBreakUntil } from '../lib/breakState';
import { useUnreadStore } from './unreadStore';

interface Geofence {
  polygon_coordinates: { lat: number; lng: number }[] | null;  // API sends null for a site with no polygon drawn
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
  /** Site feature flags (schema_v47). Cached at clock-in / restore like
   *  ping_interval_minutes — admin edits mid-shift do NOT propagate (Q37
   *  semantics; refreshFromServer never rewrites activeShift). Optional on
   *  the wire: a pre-v47 API omits both. READ THEM ONLY through
   *  lib/siteFlags.ts — absence fails safe (checkpoints TRUE,
   *  inspection FALSE). */
  checkpoints_enabled?: boolean;
  vehicle_inspection_required?: boolean;
  geofence?: Geofence;
}

interface ShiftSession {
  id: string;
  shift_id: string;
  clocked_in_at: string;
}

/** Phase D — open break_sessions row for the currently active shift.
 *  Populated from /shifts/active-session on refreshFromServer (cold start +
 *  every AppState 'active') and mutated locally by /break-start / /break-end.
 *  The break screen and home banner derive remaining from
 *  break_start + planned_duration_minutes and Date.now() on every tick, so
 *  a JS-thread suspension during backgrounding no longer freezes the timer. */
interface CurrentBreak {
  break_id: string;
  /** Server timestamptz — parseable via new Date(). */
  break_start: string;
  break_type: 'meal' | 'rest' | 'other';
  planned_duration_minutes: number;
}

/** Break-enforcement package — per-type used/limit from
 *  /shifts/active-session's break_quotas (schema_v46 API). Optional on the
 *  wire: a pre-v46 API omits it and the break screen renders no quota row
 *  and disables nothing (server still enforces). */
export type BreakQuotas = Record<
  'meal' | 'rest' | 'other',
  { used: number; limit: number }
>;

interface ShiftState {
  pendingShift: Shift | null;
  activeShift: Shift | null;
  activeSession: ShiftSession | null;
  currentBreak: CurrentBreak | null;
  /** Server-truth break allowance state; null until the first
   *  /shifts/active-session response that carries break_quotas. */
  breakQuotas: BreakQuotas | null;
  /** Last ping window this device successfully submitted, as
   *  { sessionId, label }. Read by the PING NOW gate on the active-shift
   *  screen to grey the tile once the current window is satisfied.
   *
   *  Deliberately NOT authoritative: this store is not persisted, so a cold
   *  start mid-shift forgets it. The gate therefore fails OPEN (tile stays
   *  enabled) rather than closed. A redundant ping writes one extra
   *  location_pings row; a wrongly-disabled tile recreates the dead end
   *  that left 17 windows unanswered on STARNET shift b8d23d66. There is no
   *  server endpoint that reports pings for the current window — adding one
   *  is the real fix and is an API change. */
  lastPingedWindow: { sessionId: string; label: string } | null;
  setPendingShift: (shift: Shift) => void;
  setActiveSession: (shift: Shift, session: ShiftSession) => void;
  clearSession: () => void;
  setCurrentBreak: (b: CurrentBreak | null) => void;
  markWindowPinged: (sessionId: string, label: string) => void;
  /** Reconcile cached server-derived state with the server. Non-throwing:
   *  see the body comment for the drift scenarios and the silent-fail
   *  semantics. */
  refreshFromServer: () => Promise<void>;
}

export const useShiftStore = create<ShiftState>((set, get) => ({
  pendingShift: null,
  activeShift: null,
  activeSession: null,
  currentBreak: null,
  breakQuotas: null,
  lastPingedWindow: null,

  setPendingShift: (shift) => set({ pendingShift: shift }),

  setActiveSession: (shift, session) => {
    // lastPingedWindow is scoped to a session id, but clear it on every
    // session swap anyway so a handoff rotation can never inherit the
    // outgoing guard's answered window.
    set({ activeShift: shift, activeSession: session, pendingShift: null, lastPingedWindow: null });
    setShiftTag(session.id);
  },

  clearSession: () => {
    // Breaks die with the session — clear the SecureStore mirror too.
    void clearBreakUntil();
    set({
      activeShift: null, activeSession: null, pendingShift: null,
      currentBreak: null, breakQuotas: null, lastPingedWindow: null,
    });
    setShiftTag(null);
  },

  // Single choke point for break-state transitions: startBreak, endBreak
  // (both success and 404-already-closed) and refreshFromServer all route
  // through here, so the SecureStore mirror the headless geofence task
  // reads (lib/breakState.ts) can never drift from the in-memory truth.
  // Fire-and-forget — Keychain latency must not block UI state.
  setCurrentBreak: (b) => {
    if (b) void persistBreakUntil(b.break_start, b.planned_duration_minutes);
    else void clearBreakUntil();
    set({ currentBreak: b });
  },

  markWindowPinged: (sessionId, label) => set({ lastPingedWindow: { sessionId, label } }),

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
      const active = await apiClient.get<{
        session: { id: string };
        current_break?: CurrentBreak | null;
        break_quotas?: BreakQuotas;
      } | null>('/shifts/active-session');
      const state = get();
      if (!active && state.activeSession) {
        set({
          activeShift: null, activeSession: null, pendingShift: null,
          currentBreak: null, lastPingedWindow: null,
        });
        setShiftTag(null);
        Sentry.addBreadcrumb({
          category: 'session_refresh',
          message: 'server returned null — cleared cached session',
          level: 'info',
          data: { had_session_id: state.activeSession.id },
        });
      } else if (active) {
        // Reconcile the open break specifically. We deliberately do NOT
        // overwrite activeShift here (see the "why we don't setActiveSession"
        // block above — /active-session lacks the site geofence). currentBreak
        // has no such coupling: it's a pure derived server-truth string of
        // fields, safe to overwrite on every refresh. Null means "no open
        // break" and should clear a cached one.
        const nextBreak = active.current_break ?? null;
        if (JSON.stringify(state.currentBreak) !== JSON.stringify(nextBreak)) {
          // Through setCurrentBreak (not a bare set) so the SecureStore
          // break mirror follows server truth — this is how the app learns
          // of a server auto-close it slept through.
          get().setCurrentBreak(nextBreak);
        }
        // Quota state is pure server truth like currentBreak — overwrite on
        // every refresh. Absent field (pre-v46 API) leaves the cache alone.
        if (active.break_quotas &&
            JSON.stringify(state.breakQuotas) !== JSON.stringify(active.break_quotas)) {
          set({ breakQuotas: active.break_quotas });
        }
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
