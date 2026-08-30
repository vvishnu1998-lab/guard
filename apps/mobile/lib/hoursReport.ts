/**
 * Guard Hours PDF — range presets, server error copy, download and save.
 *
 * The pure parts (presets, clamping, error copy) are exported separately from
 * the IO so they can be exercised without a device or a running API.
 *
 * SERVER IS THE GATE. Everything here that looks like validation is a
 * courtesy: it keeps the guard from making a request that is certain to fail
 * and gives them a readable reason a beat sooner. GET /shifts/my-hours.pdf
 * enforces the 45-day cap, the ordering, and the date shape itself, and this
 * file must never be the only thing standing between a bad range and the
 * server. If the two ever disagree, the server wins and the guard sees the
 * server's message.
 */
import ReactNativeBlobUtil from 'react-native-blob-util';
import * as Sharing from 'expo-sharing';
import * as SecureStore from 'expo-secure-store';
import {
  MAX_RANGE_DAYS, localRangeProblem, hoursErrorCopy,
} from './hoursRange';

export { MAX_RANGE_DAYS, RANGE_PRESETS, rangeDays, localRangeProblem, hoursErrorCopy, ymd } from './hoursRange';
export type { RangePreset } from './hoursRange';

const DOWNLOAD_TIMEOUT_MS = 30_000;

// ── Download + save ───────────────────────────────────────────────────────

/** Single explicit discriminant. An earlier shape used `ok` plus an optional
 *  `empty`, which TypeScript would not narrow through the caller's
 *  try/finally — and an un-narrowed union here is exactly how an empty period
 *  would end up rendered as an error string. */
export type HoursResult =
  | { status: 'saved';  savedVia: 'share-sheet'; path: string }
  | { status: 'empty' }
  | { status: 'error';  message: string };

function originOf(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

const API_BASE   = process.env.EXPO_PUBLIC_API_URL ?? '';
const API_ORIGIN = originOf(API_BASE);

/**
 * Fetch the PDF with the guard's bearer token and hand it to the OS.
 *
 * WHY react-native-blob-util AND NOT Linking.openURL: the route is
 * requireAuth('guard'), so the request must carry an Authorization header.
 * Linking.openURL hands a bare URL to the system browser, which sends no
 * header and receives a 401. Same reasoning, and the same library, as
 * components/SiteInstructionsModal.tsx.
 *
 * The token is attached ONLY when the URL is our own API origin — the
 * defence-in-depth rule from that file, kept here rather than re-derived.
 */
export async function downloadHoursPdf(from: string, to: string): Promise<HoursResult> {
  const local = localRangeProblem(from, to);
  if (local) return { status: 'error', message: local };

  const url = `${API_BASE}/api/shifts/my-hours.pdf?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (API_ORIGIN == null || originOf(url) !== API_ORIGIN) {
    // Cannot happen with a well-formed EXPO_PUBLIC_API_URL; refuse rather
    // than send the guard's token to an unexpected host.
    return { status: 'error', message: 'App is misconfigured. Contact your supervisor.' };
  }

  const token = await SecureStore.getItemAsync('guard_access_token');
  if (!token) return { status: 'error', message: 'Your session expired. Sign in again to download your hours.' };

  let res: Awaited<ReturnType<ReturnType<typeof ReactNativeBlobUtil.config>['fetch']>>;
  try {
    res = await ReactNativeBlobUtil
      .config({ fileCache: true, appendExt: 'pdf', timeout: DOWNLOAD_TIMEOUT_MS })
      .fetch('GET', url, { Authorization: `Bearer ${token}` });
  } catch {
    return { status: 'error', message: 'Couldn\'t reach the server. Check your connection and try again.' };
  }

  const status = res.info().status;
  if (status !== 200) {
    // The error body is JSON, but it landed on disk because fileCache is on.
    let body: { code?: string; days?: number } | null = null;
    try { body = JSON.parse(await res.text()); } catch { /* not JSON — fall through to status copy */ }
    try { res.flush(); } catch { /* cache cleanup is best-effort */ }
    return { status: 'error', message: hoursErrorCopy(status, body) };
  }

  // ── Empty range (H2.6) ──────────────────────────────────────────────────
  //
  // The server always returns a valid PDF — an empty period renders as
  // "No shifts recorded in this period." rather than an error, which is the
  // right behaviour for a document but the wrong experience for a guard who
  // tapped Download and got a page with nothing on it.
  //
  // We branch on a count header when the server sends one. It does NOT send
  // one today: the H1 route sets no such header, so this path is inert until
  // a one-line server change adds it. Written now so the client half is not
  // the blocker, and so the fallback is explicit rather than accidental —
  // without the header we save the file, and the PDF says plainly that the
  // period was empty.
  const headers = res.info().headers ?? {};
  const rawCount =
    (headers['x-netraops-shift-count'] as string | undefined) ??
    (headers['X-NetraOps-Shift-Count'] as string | undefined);
  if (rawCount != null && /^\d+$/.test(rawCount) && Number(rawCount) === 0) {
    try { res.flush(); } catch { /* cache cleanup is best-effort */ }
    return { status: 'empty' };
  }

  const path = res.path();

  // ── Save (H2.4) ─────────────────────────────────────────────────────────
  //
  // iOS: expo-sharing presents the system share sheet, whose "Save to Files"
  // action is the deliverable. There is no Files-picker API on iOS outside
  // the share sheet, so this IS the save path, not a fallback for one.
  //
  // Android: the same share sheet is used, NOT addAndroidDownloads. Two
  // reasons. addAndroidDownloads is configured on the REQUEST, so choosing it
  // would mean issuing the download twice, or committing to the Downloads
  // folder before knowing the response was a 200 rather than a JSON error —
  // and it writes to a fixed location with no chance to pick a destination.
  // The share sheet on Android offers "Save to Files"/Drive/etc. and gives
  // the same "choose where it goes" behaviour as iOS, so the two platforms
  // stay one code path.
  if (!(await Sharing.isAvailableAsync())) {
    // Documented as always true on iOS and Android; the guard is not left
    // without a next step if a device disagrees.
    return {
      status: 'error',
      message: `Saved to the app's files, but this device can't open the share sheet. Path: ${path}`,
    };
  }
  await Sharing.shareAsync(`file://${path}`, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: 'Save your hours summary',
  });
  return { status: 'saved', savedVia: 'share-sheet', path };
}

