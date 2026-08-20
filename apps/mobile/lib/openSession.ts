/**
 * Shared handler for the server's 409 OPEN_SESSION_EXISTS.
 *
 * POST /shifts/:id/clock-in and /handoff-clock-in both reject with 409 when
 * idx_shift_sessions_one_open_per_guard already holds an open session for
 * this guard (api commit 9638dd7).
 *
 * Aug 18 incident: the client showed the raw error and stopped there. The
 * guard was left on a dead wizard screen, still believing they were off
 * shift, while the server held an open session for them. The state, not the
 * copy, was the problem — same diagnosis as SESSION_CLOSED, mirrored here.
 *
 * WHY WE REFETCH INSTEAD OF USING THE 409 PAYLOAD
 *
 *   The 409 body carries open_session { shift_id, site_id, site_name,
 *   clocked_in_at } — enough to name the site in a message, NOT enough to
 *   restore. It has no geofence. Seeding activeShift from it would produce
 *   an on-shift state whose fence is missing, and the background geofence
 *   effect in app/_layout.tsx is gated on `activeSession && activeShift
 *   ?.geofence` — so region monitoring would never arm. The guard would look
 *   clocked in and be silently unmonitored, which is worse than the dead end
 *   we are fixing.
 *
 *   GET /shifts/active-session does return the fence (shifts.ts LEFT JOINs
 *   site_geofence and builds the geofence object), so it is the only correct
 *   restore source. open_session is used for breadcrumbs only.
 *
 *   NB: the "no geofence on /active-session" comment above refreshFromServer
 *   in store/shiftStore.ts is stale — it predates that LEFT JOIN.
 *
 * On refetch failure we deliberately do NOT guess at on-shift state. We show
 * the server's sentence and route home, where restoreOrFetchShift retries
 * and — since the fail-loud change — raises the offline banner rather than
 * rendering the guard as off shift.
 */
import { Alert } from 'react-native';
import { router } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import { ApiError, apiClient } from './apiClient';
import { useShiftStore } from '../store/shiftStore';

/** Narrowing guard.
 *
 *  Keyed on details.code, NOT err.code. ApiError derives .code from the
 *  response's `error` field, and this endpoint puts the human sentence
 *  there while the machine code lives in `code` — unlike GEOFENCE_FAILED
 *  and TOO_EARLY, which put the code in `error`. `err.code ===
 *  'OPEN_SESSION_EXISTS'` therefore never matches. Same trap the comment
 *  above the GEOFENCE_FAILED branch in clock-in/step4.tsx describes. */
export function isOpenSessionConflict(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    (err.details as { code?: unknown } | undefined)?.code === 'OPEN_SESSION_EXISTS'
  );
}

/** Subset of GET /shifts/active-session needed to rehydrate. */
interface ActiveSessionRestore {
  shift: {
    id: string;
    site_id: string;
    site_name: string;
    scheduled_start: string;
    scheduled_end: string;
    instructions_pdf_url?: string | null;
    ping_interval_minutes?: number;
    checkpoints_enabled?: boolean;
    vehicle_inspection_required?: boolean;
    /** Null for a site with no fence configured. */
    geofence?: {
      polygon_coordinates: { lat: number; lng: number }[] | null;
      center_lat: number;
      center_lng: number;
      radius_meters: number;
    } | null;
  };
  session: { id: string; shift_id: string; clocked_in_at: string };
}

/**
 * Rehydrate on-shift state, tell the guard calmly, and route them home.
 *
 * `where` identifies the calling screen in the Sentry breadcrumb.
 * Breadcrumb, not captureException: colliding with your own open session is
 * expected behaviour under state loss, not a crash — same treatment
 * SESSION_CLOSED gets in lib/sessionClosed.ts.
 */
export async function handleOpenSessionConflict(err: ApiError, where: string): Promise<void> {
  const openSession = (err.details as { open_session?: Record<string, unknown> | null })
    ?.open_session ?? null;

  Sentry.addBreadcrumb({
    category: 'open_session_conflict',
    message: `OPEN_SESSION_EXISTS surfaced at ${where}`,
    level: 'warning',
    data: {
      // Server returns open_session: null when the session vanished between
      // the 23505 and its lookup (clock-out race) — not an error here.
      had_open_session_payload: openSession !== null,
      shift_id: (openSession?.shift_id as string) ?? null,
    },
  });

  let restored = false;
  try {
    const active = await apiClient.get<ActiveSessionRestore | null>('/shifts/active-session');
    if (active) {
      const { geofence, ...shift } = active.shift;
      useShiftStore
        .getState()
        .setActiveSession(geofence ? { ...shift, geofence } : shift, active.session);
      restored = true;
    }
  } catch (refetchErr) {
    Sentry.addBreadcrumb({
      category: 'open_session_conflict',
      message: 'active-session refetch failed — showing message without restore',
      level: 'warning',
      data: { error: (refetchErr as Error)?.message ?? String(refetchErr) },
    });
  }

  Sentry.addBreadcrumb({
    category: 'open_session_conflict',
    message: restored ? 'restored on-shift state' : 'no restore — message only',
    level: 'info',
  });

  // err.message is the server's own sentence, which names the site and the
  // clock-in time in site-local terms ("You're already clocked in at X since
  // 8:00 PM PT."). Deliberately not reworded here: this screen has no site
  // timezone to format with, and a wrong time is worse than none.
  Alert.alert(
    'Already Clocked In',
    err.message,
    [{ text: 'OK', onPress: () => router.replace('/(tabs)/home') }],
    { cancelable: false },
  );
}
