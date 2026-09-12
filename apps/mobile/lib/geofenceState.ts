/**
 * Inside/outside state for the active post, and the decision of whether a
 * native geofence event is a REAL transition or an artefact of registration.
 *
 * WHY THIS EXISTS — Bug 2, 2026-09-12 audit. `expo-location` synthesises an
 * ENTER every time a region is registered while the device is already inside
 * it, on both platforms and unconditionally:
 *
 *   Android — GeofencingTaskConsumer.kt:168
 *     .setInitialTrigger(INITIAL_TRIGGER_ENTER or INITIAL_TRIGGER_EXIT)
 *   iOS     — EXGeofencingTaskConsumer.m:64,71,89,91: a fresh regionStates
 *     dictionary is allocated per registration and seeded to
 *     CLRegionStateUnknown, then requestStateForRegion fires
 *     didDetermineState; :158 compares Unknown(0) != Inside(1) and emits
 *     Enter.
 *
 * The app re-registers on every cold start (_layout.tsx's geofence effect,
 * keyed on activeSession?.id / activeShift?.geofence) and iOS re-arms again
 * at process start with no JS involved at all (didRegisterTask). So a guard
 * who never moved got "Back on post" every time the app came back.
 *
 * The task had no way to tell the two apart because it kept no prior state —
 * the file's own header used to assert "native geofencing IS the state
 * machine", which is exactly the assumption that turned out to be false.
 * This module is the state machine, restored deliberately and scoped to one
 * session.
 *
 * Pure: no SecureStore, no expo-location, no React Native. The caller does
 * the I/O; scripts/check-geofence-transitions.ts proves the table.
 */

/** Where the guard is relative to their post. */
export type PostState = 'inside' | 'outside';

/** What we managed to read back — 'unknown' covers absent, unparseable, and
 *  belonging to a different session. */
export type StoredState = PostState | 'unknown';

export type GeofenceEvent = 'enter' | 'exit';

export interface TransitionDecision {
  /** Fire the local notification? (The caller still applies the break-quiet
   *  and shift-expiry gates on top of this.) */
  notify:    boolean;
  /** What to persist after handling the event. */
  nextState: PostState;
  /** Short, stable reason for the Sentry breadcrumb. Not guard-facing. */
  reason:    string;
}

/**
 * ONE key, not one per session.
 *
 * SecureStore has no enumeration API — only get/set/delete by exact key — so
 * a `geofence_state_<sessionId>` scheme could never be swept and would leave
 * one orphaned keychain entry per shift, forever. (A literal
 * `geofence_state:<sessionId>` is not even writable: SecureStore rejects any
 * key outside [alphanumeric . - _], so the colon throws.)
 *
 * Embedding the session id in the VALUE instead gives the same scoping with
 * none of that: a record from a previous session reads back as 'unknown', so
 * a new shift can never inherit a stale inside/outside. It also means the
 * existing cleanup at _layout.tsx:343 — which already deletes this exact key
 * whenever there is no active session, i.e. on clock-out — is the whole of
 * the session-end teardown, with no new code to keep in step.
 */
export const GEOFENCE_STATE_KEY = 'geofence_state';

interface StoredRecord {
  sessionId: string;
  state:     PostState;
}

export function serializeGeofenceState(sessionId: string, state: PostState): string {
  const record: StoredRecord = { sessionId, state };
  return JSON.stringify(record);
}

/**
 * Read back a persisted state, scoped to `sessionId`.
 *
 * Everything ambiguous collapses to 'unknown', which suppresses. That is the
 * safe direction here: a spurious "Back on post" is the bug being fixed, and
 * the cost of suppressing a genuine one is that the guard misses an
 * informational banner about something they can already see — they are
 * standing on their post.
 *
 * 'unknown' also absorbs the pre-Build-34 value, which was a bare 'inside' /
 * 'outside' string under this same key. JSON.parse throws on it, so an old
 * install upgrading into this build starts from a clean slate rather than
 * trusting a record written by a different state machine.
 */
export function readStoredState(raw: string | null, sessionId: string): StoredState {
  if (!raw) return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unknown';                       // legacy bare string, or corrupt
  }
  if (!parsed || typeof parsed !== 'object') return 'unknown';
  const rec = parsed as Partial<StoredRecord>;
  if (rec.sessionId !== sessionId) return 'unknown';   // different shift
  if (rec.state !== 'inside' && rec.state !== 'outside') return 'unknown';
  return rec.state;
}

/**
 * The transition table.
 *
 *   event   stored     notify   next      why
 *   ------  ---------  -------  --------  ---------------------------------
 *   exit    any        yes      outside   leaving is always real: the OS
 *                                         does not synthesise an EXIT for a
 *                                         device that is inside
 *   enter   outside    YES      inside    the only genuine re-entry
 *   enter   inside     no       inside    duplicate — re-registration while
 *                                         already on post. THE BUG.
 *   enter   unknown    no       inside    first event of the session, or a
 *                                         record from another session. Adopt
 *                                         the position silently.
 *
 * The 'unknown' row is what makes clock-in quiet: the guard clocks in while
 * standing on post, registration fires a synthetic ENTER, and with nothing
 * stored there is no evidence they were ever outside.
 *
 * It also costs one edge case, deliberately: a guard who clocks in from
 * OUTSIDE the fence and then walks in gets no "Back on post" for that first
 * arrival, because no EXIT was ever recorded to transition from. Every
 * subsequent exit/enter pair behaves normally. Under-notifying once beats
 * notifying on every foreground.
 */
export function decideTransition(event: GeofenceEvent, stored: StoredState): TransitionDecision {
  if (event === 'exit') {
    return { notify: true, nextState: 'outside', reason: 'exit' };
  }
  if (stored === 'outside') {
    return { notify: true, nextState: 'inside', reason: 'genuine re-entry' };
  }
  return {
    notify:    false,
    nextState: 'inside',
    reason:    stored === 'inside' ? 'already inside' : 'no prior state',
  };
}
