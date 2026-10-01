/**
 * U3 (N146): should the cached window of an OPEN session be rewritten from
 * what GET /shifts/active-session just returned?
 *
 * Since D20 an admin can move an active shift's end. The app cached
 * activeShift at clock-in and refreshFromServer never rewrote it, so a warm
 * app kept the OLD end until a cold start: Time Left, SCHEDULED END and the
 * PING tile went stale, and the background task's expiry gate (which reads a
 * SecureStore copy of the end) went silent at old end + grace while the
 * server still had the guard on shift.
 *
 * Only scheduled_start and scheduled_end are ever taken from the server.
 * Everything else on activeShift stays as cached, deliberately:
 *   - geofence: _layout.tsx's geofence effect depends on its object identity,
 *     and a fresh object re-registers the region (stop + start), which fires
 *     a synthetic Enter or Exit. Mid-shift fence redraws are out of scope.
 *   - ping_interval_minutes, checkpoints_enabled, vehicle_inspection_required:
 *     cached at clock-in on purpose (Q37).
 * A close in the past is not decided here: the server answers null and
 * refreshFromServer clears the session.
 *
 * Pure, with no React Native imports, so scripts/check-end-reconcile.ts can
 * run it.
 */
import { isPastShiftExpiry } from './shiftExpiry';

export interface CachedWindow {
  sessionId:      string;
  shiftId:        string;
  scheduledStart: string;
  scheduledEnd:   string;
}

/** What /shifts/active-session carried, taken as unknown: this may meet an
 *  older or newer API, and a field that is not a string must not be trusted. */
export interface ServerWindow {
  sessionId:      unknown;
  shiftId:        unknown;
  scheduledStart: unknown;
  scheduledEnd:   unknown;
}

export type KeepReason =
  | 'no_cached_session'   // nothing on shift locally; home's restore owns that
  | 'no_shift_in_response'
  | 'different_session'   // e.g. a handoff rotated sessions; not U3's to fix
  | 'different_shift'
  | 'unparseable'
  | 'not_after_start'     // the server would never send it (v81); refuse anyway
  | 'unchanged';

export type WindowDecision =
  | { kind: 'rewrite'; scheduledStart: string; scheduledEnd: string }
  | { kind: 'keep'; reason: KeepReason };

export function decideWindowRewrite(
  cached: CachedWindow | null,
  server: ServerWindow | null,
): WindowDecision {
  if (!cached) return { kind: 'keep', reason: 'no_cached_session' };
  if (!server || typeof server.shiftId !== 'string') {
    return { kind: 'keep', reason: 'no_shift_in_response' };
  }
  if (server.sessionId !== cached.sessionId) return { kind: 'keep', reason: 'different_session' };
  if (server.shiftId !== cached.shiftId) return { kind: 'keep', reason: 'different_shift' };

  const { scheduledStart, scheduledEnd } = server;
  if (typeof scheduledStart !== 'string' || typeof scheduledEnd !== 'string') {
    return { kind: 'keep', reason: 'unparseable' };
  }
  const startMs = Date.parse(scheduledStart);
  const endMs   = Date.parse(scheduledEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { kind: 'keep', reason: 'unparseable' };
  }
  if (!(endMs > startMs)) return { kind: 'keep', reason: 'not_after_start' };

  // Compare instants, not strings: the cached copy may have come from
  // GET /shifts/:id (clock-in) and this one from /active-session.
  if (startMs === Date.parse(cached.scheduledStart) && endMs === Date.parse(cached.scheduledEnd)) {
    return { kind: 'keep', reason: 'unchanged' };
  }
  return { kind: 'rewrite', scheduledStart, scheduledEnd };
}

/**
 * Is a 'shift_schedule_edited' push about the shift this device is on?
 *
 * The same type announces edits to SCHEDULED shifts too (routes/shifts.ts
 * PATCH /:id), which never share the active shift's id. With no session there
 * is nothing to reconcile — home's restore reads the fresh shift. A payload
 * without a string shift_id counts as a match: one GET is cheaper than
 * missing a close.
 */
export function isEditForActiveShift(
  data: Record<string, unknown> | undefined,
  hasSession: boolean,
  activeShiftId: string | undefined,
): boolean {
  if (!hasSession) return false;
  const shiftId = data?.shift_id;
  return !(typeof shiftId === 'string' && shiftId !== activeShiftId);
}

/**
 * After a window change under an open session, should the region be
 * re-registered? Only when the OLD end had already run out — so the
 * background gate dropped events without recording them in geofence_state —
 * and the NEW end has not. `pending` carries a re-arm a second, quicker edit
 * cancelled before it ran.
 */
export function shouldRearmAfterWindowChange(
  pending: boolean,
  prevEnd: string,
  nextEnd: string,
  nowMs: number,
): boolean {
  return (pending || isPastShiftExpiry(prevEnd, nowMs)) && !isPastShiftExpiry(nextEnd, nowMs);
}
