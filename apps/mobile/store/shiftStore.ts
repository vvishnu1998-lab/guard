import { create } from 'zustand';
import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';
import { setShiftTag } from '../lib/sentry';
import { apiClient } from '../lib/apiClient';
import { persistBreakUntil, clearBreakUntil } from '../lib/breakState';
import {
  ANSWERED_WINDOW_KEY, serializeAnsweredWindow, parseAnsweredWindow, shouldApplyStored,
} from '../lib/answeredWindow';
import { isUsableShiftEnd } from '../lib/shiftExpiry';
import { decideWindowRewrite, isEditForActiveShift } from '../lib/activeShiftReconcile';
import { createCoalescer, createSerialQueue } from '../lib/asyncQueue';
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
   *  semantics; refreshFromServer rewrites only scheduled_start and
   *  scheduled_end — lib/activeShiftReconcile.ts). Optional on
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
  /** `string`, not a union. From schema_v61 the server only ever sends
   *  'break', but a row written before that migration still carries
   *  'meal' | 'rest' | 'other', and a binary from this branch can run
   *  against the pre-Phase-2 API which sends the old values for NEW rows
   *  too. Narrowing this to 'break' would make the type lie in the exact
   *  window this build ships into. Consumers render it, never branch on it. */
  break_type: string;
  planned_duration_minutes: number;
}

/**
 * Whatever GET /shifts/active-session put in `break_quotas`, carried through
 * UNINTERPRETED.
 *
 * Deliberately `unknown` rather than a shape. This field has had two
 * incompatible shapes in production and this store may run against either:
 *
 *   OLD (schema_v46 API, currently deployed)
 *     { meal: {used,limit}, rest: {used,limit}, other: {used,limit} }
 *   NEW (one-break-type API)
 *     { used, limit, can_start, eligible_at, reason }
 *
 * A binary built from this branch can install BEFORE the API deploys, so the
 * old shape is not merely legacy — it is the shape this code will meet first.
 * Typing it as either one would be a lie in one of those worlds, and a `.map`
 * or an index on the wrong shape is how a screen dies.
 *
 * The store's only jobs are to stringify-compare and hold it. All
 * interpretation happens in app/break/index.tsx's parseAllowance(), which
 * recognises the NEW shape and treats everything else — old shape, malformed,
 * absent — as "no information", failing open. The server's 422 is the only
 * real enforcement either way.
 */
export type BreakQuotas = unknown;

interface ShiftState {
  pendingShift: Shift | null;
  activeShift: Shift | null;
  activeSession: ShiftSession | null;
  currentBreak: CurrentBreak | null;
  /** Server-truth break allowance state; null until the first
   *  /shifts/active-session response that carries break_quotas. */
  breakQuotas: BreakQuotas | null;
  /** Last ping window this device successfully submitted, as
   *  { sessionId, label }. Read by the PING gate (lib/pingTile.ts) on the
   *  active-shift screen and on Home to grey the tile once the current
   *  window is satisfied.
   *
   *  Mirrored to SecureStore (lib/answeredWindow.ts) and restored by
   *  setActiveSession, so an app restart mid-shift no longer forgets it.
   *  Still deliberately NOT authoritative: a value that cannot be read back
   *  leaves it null, and the gate fails OPEN (tile stays enabled) rather
   *  than closed. A redundant ping writes one extra location_pings row; a
   *  wrongly-disabled tile recreates the dead end that left 17 windows
   *  unanswered on STARNET shift b8d23d66. There is no server endpoint that
   *  reports pings for the current window — adding one is the real fix and
   *  is an API change. */
  lastPingedWindow: { sessionId: string; label: string } | null;
  setPendingShift: (shift: Shift) => void;
  setActiveSession: (shift: Shift, session: ShiftSession) => void;
  clearSession: () => void;
  setCurrentBreak: (b: CurrentBreak | null) => void;
  markWindowPinged: (sessionId: string, label: string) => void;
  /** Reconcile cached server-derived state with the server. Non-throwing:
   *  see refreshOnce below for the drift scenarios and the silent-fail
   *  semantics. Concurrent calls coalesce (lib/asyncQueue.ts): the promise
   *  settles after a fetch that started after the call. */
  refreshFromServer: () => Promise<void>;
  /** Hydrate activeShift + activeSession from the server when the store has
   *  none. For deep-links that land before home has mounted. Resolves to the
   *  session, or null when the server says there is no open one. */
  restoreSessionIfMissing: () => Promise<ShiftSession | null>;
}

/** In-flight guard for restoreSessionIfMissing.
 *
 *  Module scope, not store state: two screens mounting in the same frame —
 *  a deep-linked /ping and the home tab underneath it — would otherwise each
 *  fire their own GET /shifts/active-session, and the second setActiveSession
 *  would re-trip the geofence effect for a session already armed. Callers
 *  share the first promise instead. Cleared in a finally so a failed restore
 *  does not wedge every later attempt. */
let restoreInFlight: Promise<ShiftSession | null> | null = null;

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
    // ...then restore THIS session's answer from before an app restart, if
    // there is one (lib/answeredWindow.ts). Fails open: no value, a bad
    // value or another session's value leaves the tile live.
    void SecureStore.getItemAsync(ANSWERED_WINDOW_KEY)
      .then((raw) => {
        const stored = parseAnsweredWindow(raw, session.id);
        const s = get();
        if (shouldApplyStored({ stored, current: s.lastPingedWindow, activeSessionId: s.activeSession?.id ?? null })) {
          set({ lastPingedWindow: stored });
        }
      })
      .catch(() => {});
  },

  clearSession: () => {
    // Breaks die with the session — clear the SecureStore mirror too.
    void clearBreakUntil();
    // So does the answered ping window.
    void SecureStore.deleteItemAsync(ANSWERED_WINDOW_KEY).catch(() => {});
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

  // Persisted as well, so an app restart does not forget it (N173).
  // Fire-and-forget — Keychain latency must not block UI state.
  markWindowPinged: (sessionId, label) => {
    set({ lastPingedWindow: { sessionId, label } });
    void SecureStore.setItemAsync(ANSWERED_WINDOW_KEY, serializeAnsweredWindow({ sessionId, label }))
      .catch(() => {});
  },

  // The body is refreshOnce() below the store; this is the coalesced entry
  // point every caller uses.
  refreshFromServer: () => coalescedRefresh(),

  /**
   * Hydrate the session when the store has none — for a screen reached by
   * DEEP LINK before home has mounted.
   *
   * WHY THIS EXISTS. This store is not persisted, so a cold start has
   * activeSession === null until something fetches it. The only thing that
   * did was home.tsx's restoreOrFetchShift, which is a local function bound
   * to home's own React state (setLoadingShift / setRestoreFailed /
   * fetchUpcomingShift) and cannot be called from another screen. So a push
   * tapped from a KILLED app routed to /ping, found no session, and bounced
   * to home — the guard tapped "Submit your 13:30 ping" and landed on the
   * home tab (session bb3934c9, 2026-09-12 20:30).
   *
   * refreshFromServer is NOT an alternative: it only reconciles a session the
   * store already holds — clears one the server reports gone, rewrites an open
   * one's scheduled_start/end — and never calls setActiveSession, so from null
   * it is a no-op.
   *
   * ⚠️ HYDRATION RE-ARMS THE GEOFENCE. setActiveSession rewrites activeShift,
   * which is a dependency of _layout.tsx's geofence effect, so this triggers
   * startBackgroundLocation → stopGeofencingAsync + startGeofencingAsync.
   * Both platforms synthesise an ENTER on registration when the device is
   * already inside the region (Android INITIAL_TRIGGER_ENTER; iOS seeds
   * regionStates to Unknown), which before batch/mobile-16 would have fired a
   * spurious "Back on post" on every deep-link restore. It does not now ONLY
   * because lib/geofenceState.ts suppresses an ENTER that does not follow a
   * recorded EXIT. That suppression is load-bearing for this action — if it
   * is ever removed or weakened, this path starts lying to guards again.
   *
   * DELIBERATELY THIN. home.tsx keeps its own retry/backoff, its
   * restore-failed banner and its upcoming-shift fallthrough; that code has
   * the 2026-08-18 "unknown state rendered as not-on-shift" incident behind
   * it and is not moved here. This is one GET and one setActiveSession: it
   * either hydrates or it does not, and the caller decides what to show.
   *
   * Returns the session on success, null when the server confirms there is
   * no open one OR the fetch failed. The caller cannot distinguish those two
   * and must not: both mean "we cannot put you on the capture screen".
   */
  restoreSessionIfMissing: async () => {
    const existing = get().activeSession;
    if (existing) return existing;
    if (restoreInFlight) return restoreInFlight;

    restoreInFlight = (async () => {
      try {
        const active = await apiClient.get<{
          shift:   Shift;
          session: ShiftSession;
        } | null>('/shifts/active-session');
        if (!active?.session?.clocked_in_at) {
          Sentry.addBreadcrumb({
            category: 'shift_restore',
            message: 'restoreSessionIfMissing: server reports no open session',
            level: 'info',
          });
          return null;
        }
        get().setActiveSession(active.shift, active.session);
        Sentry.addBreadcrumb({
          category: 'shift_restore',
          message: 'restoreSessionIfMissing: hydrated from deep link',
          level: 'info',
          data: { session_id: active.session.id },
        });
        return active.session;
      } catch (err: any) {
        // Non-throwing, like refreshFromServer. A deep link that cannot
        // restore must degrade to "go to home", never to a crash on a
        // screen the guard reached from a notification.
        Sentry.addBreadcrumb({
          category: 'shift_restore',
          message: 'restoreSessionIfMissing: fetch failed',
          level: 'warning',
          data: { error: err?.message ?? String(err) },
        });
        return null;
      } finally {
        restoreInFlight = null;
      }
    })();

    return restoreInFlight;
  },
}));

/** What refreshOnce reads from GET /shifts/active-session. `shift` is typed
 *  optional because only three of its fields are used here, and a response
 *  without it must degrade to today's behaviour, not throw. */
interface ActiveSessionResponse {
  shift?: { id?: unknown; scheduled_start?: unknown; scheduled_end?: unknown } | null;
  session: { id: string };
  current_break?: CurrentBreak | null;
  break_quotas?: BreakQuotas;
}

// Walk-test 2026-07-10 BUG H tail. Build 30 wired clearSession() into
// both the foreground push receiver (_layout.tsx addNotificationReceived
// Listener) and the tap handler (navigateForNotification.ts). Neither
// fires when the push arrives while the app is backgrounded AND the
// user later opens the app via the icon (dismissing or ignoring the OS
// banner). In that path the cached activeSession stays intact and home
// keeps showing SHIFT ACTIVE + CLOCK OUT for a session that no longer
// exists server-side.
//
// Called (through refreshFromServer) from:
//   - AppState 'active' transition in _layout.tsx (throttled to 2s to
//     absorb iOS Control Center swipes that fire background↔active
//     transitions on every pane change).
//   - useFocusEffect on the home tab in (tabs)/home.tsx (covers the
//     intra-app case where the guard was on a different tab when the
//     drift happened and returns to home without a background trip).
//   - a 'shift_schedule_edited' push for the active shift, received in the
//     foreground or tapped (refreshIfActiveShiftEdited below) — U3 (N146).
//   - the break screen, and lib/sessionClosed.ts after a 409.
//
// Silent-fail semantics (per spec 2026-07-10):
//   - Server 200 with body === null → cache had activeSession → clear.
//     That is also how a close in the past by an admin (D20) lands.
//   - Server 200 with body → reconcile the open break, the break quotas,
//     and the cached shift window (U3, below).
//   - Server 5xx / network error → KEEP cached state. A stray refetch
//     failure during a subway ride must not tear down an in-progress
//     shift's Live Map + Ping Countdown. Breadcrumb only, retry on next
//     AppState 'active' or home focus.
//
// Why a positive response never calls setActiveSession. The old reason —
// "/active-session returns no geofence" — has been false since cb4cbb4
// (2026-07-13). The reasons that still hold: a fresh activeShift object
// carries a NEW geofence reference, which re-runs _layout.tsx's geofence
// effect (stop + start the region, and a synthetic Enter or Exit with it);
// setActiveSession also resets lastPingedWindow; and the site fields
// (ping_interval_minutes, the checkpoint/inspection flags) are cached at
// clock-in on purpose (Q37). So U3 rewrites exactly two fields, in place:
// scheduled_start and scheduled_end (lib/activeShiftReconcile.ts). The
// spread keeps every other field — the geofence object included — by
// reference.
//
// Also refreshes inbound-invite state via unreadStore.refresh(): that
// hits /shifts/inbound-swap-requests and rewrites the ALERTS badge
// count. Without this leg, a handoff invite that arrived during
// background would leave the ALERTS badge stale (the alerts.tsx tab
// list itself has its own useFocusEffect so opening the tab still
// works — but the badge that tells the guard to open the tab wouldn't
// update until they did something else that triggered a refresh).
//
// An answer must never overrule a writer that landed while it was in flight.
// home's restore, restoreSessionIfMissing and handleOpenSessionConflict all
// call setActiveSession from their own GETs, and clearSession runs on a
// handoff or a clock-out. If activeShift or activeSession changed identity
// during this GET, the answer may predate theirs — applying it could roll a
// freshly hydrated end back to an older one, or clear a session that was just
// clocked into. So the GET is asked again, up to MAX_REFRESH_ATTEMPTS times; a
// store that keeps changing is left alone, and the next trigger re-asks.
// Nothing inside this function replaces either object before the check
// (setCurrentBreak and the breakQuotas set touch other fields), and runs are
// serialised by the coalescer, so an identity change always means another
// writer.
const MAX_REFRESH_ATTEMPTS = 3;

async function refreshOnce(): Promise<void> {
  const store = useShiftStore;
  try {
    let state = store.getState();
    let active: ActiveSessionResponse | null = null;
    let settled = false;
    for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS && !settled; attempt++) {
      const askedShift   = state.activeShift;
      const askedSession = state.activeSession;
      active = await apiClient.get<ActiveSessionResponse | null>('/shifts/active-session');
      state = store.getState();
      settled = state.activeShift === askedShift && state.activeSession === askedSession;
      if (!settled) {
        Sentry.addBreadcrumb({
          category: 'session_refresh',
          message: 'store changed during fetch — not applying this answer',
          level: 'info',
          data: { attempt },
        });
      }
    }
    if (!settled) {
      // Kept as is; the writer that overtook us had fresher data.
    } else if (!active && state.activeSession) {
      // clearSession, not a bare set: it also drops breakQuotas and the
      // SecureStore break mirror, which die with the session.
      state.clearSession();
      Sentry.addBreadcrumb({
        category: 'session_refresh',
        message: 'server returned null — cleared cached session',
        level: 'info',
        data: { had_session_id: state.activeSession.id },
      });
    } else if (active) {
      // Reconcile the open break specifically. currentBreak is a pure
      // derived server-truth string of fields, safe to overwrite on every
      // refresh. Null means "no open break" and should clear a cached one.
      const nextBreak = active.current_break ?? null;
      if (JSON.stringify(state.currentBreak) !== JSON.stringify(nextBreak)) {
        // Through setCurrentBreak (not a bare set) so the SecureStore
        // break mirror follows server truth — this is how the app learns
        // of a server auto-close it slept through.
        state.setCurrentBreak(nextBreak);
      }
      // Quota state is pure server truth like currentBreak — overwrite on
      // every refresh. Absent field (pre-v46 API) leaves the cache alone.
      if (active.break_quotas &&
          JSON.stringify(state.breakQuotas) !== JSON.stringify(active.break_quotas)) {
        store.setState({ breakQuotas: active.break_quotas });
      }

      // U3 (N146): an admin may have moved this open shift's end (D20).
      // Read the store again after the break writes above; they replace the
      // state object, though never activeShift or activeSession.
      const cur = store.getState();
      const decision = decideWindowRewrite(
        cur.activeSession && cur.activeShift
          ? {
              sessionId:      cur.activeSession.id,
              shiftId:        cur.activeShift.id,
              scheduledStart: cur.activeShift.scheduled_start,
              scheduledEnd:   cur.activeShift.scheduled_end,
            }
          : null,
        {
          sessionId:      active.session?.id,
          shiftId:        active.shift?.id,
          scheduledStart: active.shift?.scheduled_start,
          scheduledEnd:   active.shift?.scheduled_end,
        },
      );
      if (decision.kind === 'rewrite' && cur.activeShift) {
        store.setState({
          activeShift: {
            ...cur.activeShift,
            scheduled_start: decision.scheduledStart,
            scheduled_end:   decision.scheduledEnd,
          },
        });
        // The SecureStore copy the background task reads follows from
        // _layout.tsx's window effect, which depends on these two fields.
        Sentry.addBreadcrumb({
          category: 'session_refresh',
          message: 'shift window rewritten from server',
          level: 'info',
          data: {
            session_id: cur.activeSession?.id ?? null,
            old_start: cur.activeShift.scheduled_start,
            old_end:   cur.activeShift.scheduled_end,
            new_start: decision.scheduledStart,
            new_end:   decision.scheduledEnd,
          },
        });
      } else if (
        decision.kind === 'keep' &&
        decision.reason !== 'unchanged' &&
        decision.reason !== 'no_cached_session'
      ) {
        Sentry.addBreadcrumb({
          category: 'session_refresh',
          message: `shift window kept (${decision.reason})`,
          level: 'info',
        });
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
}

/** Every refreshFromServer call goes through here. A push, a foreground and
 *  the break screen's own listener can all fire within a second; they share
 *  at most two GETs, and each caller's promise settles after a GET that
 *  started after it asked — so a push is never answered by a read issued
 *  before the admin's edit committed, and the break screen's post-action
 *  refreshes never get a read from before their own POST. */
const coalescedRefresh = createCoalescer(refreshOnce);

/**
 * A 'shift_schedule_edited' push arrived (foreground) or was tapped. If it is
 * about the shift this device is on, re-read it now instead of at the next
 * cold start: an extend or shorten rewrites the cached window, a close in the
 * past clears the session.
 *
 * Which pushes count is lib/activeShiftReconcile.ts isEditForActiveShift. The
 * payload's own scheduled_start/end are never applied — it carries no outcome
 * and no session id, and two edits' pushes can arrive out of order.
 */
export function refreshIfActiveShiftEdited(data: Record<string, any> | undefined): void {
  const st = useShiftStore.getState();
  if (!isEditForActiveShift(data, !!st.activeSession, st.activeShift?.id)) return;
  const shiftId = data?.shift_id;
  Sentry.addBreadcrumb({
    category: 'session_refresh',
    message: 'shift_schedule_edited for the active shift — refetching',
    level: 'info',
    data: { shift_id: typeof shiftId === 'string' ? shiftId : null },
  });
  void st.refreshFromServer();
}

/** Serialises every write and delete of 'active_shift_end'. */
const endMirrorQueue = createSerialQueue();

/**
 * Bring SecureStore 'active_shift_end' — the copy the headless geofence task
 * reads (lib/shiftExpiry.ts) — in line with the store AS IT IS WHEN THE WRITE
 * RUNS, never with values captured earlier.
 *
 * Writes and deletes run one at a time, and each reads the store at its own
 * turn. So a slow Keychain write for an old end cannot land after a newer
 * one, and a queued write cannot resurrect the key after a clear: the clear's
 * own turn reads "no session" and deletes. The key is deleted when there is
 * no session or the window is unusable (clock-in/step4's fallback shape sets
 * end === start; persisting that would silence real breaches mid-shift, see
 * isUsableShiftEnd).
 *
 * Never throws. A failed write leaves the gate reading whatever was there —
 * the previous end of this session, or nothing (fail open).
 */
export function syncShiftEndMirror(): Promise<void> {
  return endMirrorQueue(async () => {
    const { activeSession, activeShift } = useShiftStore.getState();
    try {
      if (activeSession && activeShift &&
          isUsableShiftEnd(activeShift.scheduled_start, activeShift.scheduled_end)) {
        await SecureStore.setItemAsync('active_shift_end', activeShift.scheduled_end, {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
        });
        return;
      }
      if (activeSession && activeShift) {
        Sentry.addBreadcrumb({
          category: 'geofence',
          message: 'shift end not persisted — unusable scheduled_start/end',
          level: 'warning',
          data: {
            scheduled_start: activeShift.scheduled_start ?? null,
            scheduled_end:   activeShift.scheduled_end ?? null,
          },
        });
      }
      await SecureStore.deleteItemAsync('active_shift_end');
    } catch (err) {
      Sentry.addBreadcrumb({
        category: 'geofence',
        message: 'active_shift_end sync failed',
        level: 'warning',
        data: { error: String(err) },
      });
    }
  });
}
