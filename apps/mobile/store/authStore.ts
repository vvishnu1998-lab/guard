import { create } from 'zustand';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setUserTags } from '../lib/sentry';
import { apiClient } from '../lib/apiClient';
import { refreshTokens } from '../lib/refreshManager';
import { stopQueueSync } from '../lib/offlineQueue';
import { useShiftStore } from './shiftStore';
import { ApiError, NetworkError } from '../lib/errors';

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  guardId: string | null;
  companyId: string | null;
  mustChangePassword: boolean;

  // Actions
  loginWithEmail: (email: string, password: string, fcmToken?: string) => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  /** tokenRevoked: the server has already invalidated this session
   *  (401 + definitive refresh rejection). Skips every network call —
   *  they'd only burn rate-limited requests on dead tokens — and routes
   *  to login with the session-expired notice. */
  logout: (opts?: { tokenRevoked?: boolean }) => Promise<void>;
  loadSession: () => Promise<void>;
}

const KEYS = {
  ACCESS:  'guard_access_token',
  REFRESH: 'guard_refresh_token',
  GUARD_ID: 'guard_id',
  COMPANY_ID: 'guard_company_id',
};

// Walk-test bug #2: on iOS, expo-secure-store persists across app uninstall
// by Apple design — Keychain items with the default accessibility survive
// (a "feature" for keeping subscriptions active across reinstall). Effect:
// uninstall + reinstall left the previous guard silently signed in.
//
// AsyncStorage does NOT persist across uninstall. So we use it as a
// fresh-install probe: on cold start, if the marker is missing, this is a
// fresh install → wipe every SecureStore auth key before loadSession touches
// them. First launch after a real install always lands on the login screen.
const FRESH_INSTALL_KEY = 'guard_fresh_install_marker';

// Phase B — Keychain accessibility migration for installs predating
// the Build 37 KEYCHAIN_OPTS hardening (AFTER_FIRST_UNLOCK). Existing
// items were written under the SecureStore default
// (WHEN_UNLOCKED_THIS_DEVICE_ONLY), which throws
// errSecInteractionNotAllowed when the geofence-Exit background task
// reads them from a locked phone (tasks/locationBackground.ts:80-94).
// The check + rewrite runs once per install; the marker persists in
// AsyncStorage so subsequent launches skip.
const KEYCHAIN_MIGRATION_KEY = 'keychain_migrated_v40';

// Shared in-flight logout — see logout() below.
let pendingLogout: Promise<void> | null = null;

async function nukeSecureStoreOnFreshInstall(): Promise<void> {
  const marker = await AsyncStorage.getItem(FRESH_INSTALL_KEY);
  if (marker) return; // not a fresh install
  await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k).catch(() => {})));
  await AsyncStorage.setItem(FRESH_INSTALL_KEY, '1');
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  guardId: null,
  companyId: null,
  mustChangePassword: false,

  loginWithEmail: async (email, password, fcmToken) => {
    const data = await _request('/auth/guard/login', { email, password, fcm_token: fcmToken });
    await _saveSession(data);
    const payload = _decodeJwt(data.access);
    const guardId = data.guard_id ?? payload.sub;
    const companyId = payload.company_id ?? null;
    set({
      status: 'authenticated',
      guardId,
      companyId,
      mustChangePassword: data.must_change_password ?? false,
    });
    setUserTags({ guardId, companyId, role: payload.role });
  },

  changePassword: async (current, next) => {
    // Route through apiClient so a 401 triggers the standard
    // refresh-and-retry path (matches every other authenticated call).
    // Prior raw-fetch implementation surfaced the JWT iat / tokens_not_before
    // precision race (server fix 2760d4b) directly to the user as
    // "Session revoked by administrator" on tap of SET PASSWORD & CONTINUE.
    // ApiError.message inherits from Error, so the change-password screen's
    // existing `err?.message` alert renders the server's message unchanged.
    await apiClient.post('/auth/guard/change-password', {
      current_password: current,
      new_password: next,
    });

    // The server stamps tokens_not_before = NOW() and nulls fcm_token in the
    // same UPDATE, so every token this device holds is already revoked. If we
    // only flipped mustChangePassword (pre-Build-48 behaviour), home would
    // mount and volley authenticated calls into 401 → refresh(401) → logout
    // storms that burn the shared /api/auth rate-limit budget the guard needs
    // for their re-login (deepak lockout, 2026-08-20). Tear the session down
    // deliberately instead, mirroring logout's ordering — minus the fcm-null
    // POST, which the server has already done for us and which would only
    // spend a rate-limited request on a dead bearer token.
    stopQueueSync();
    useShiftStore.getState().clearSession();
    // No /auth/logout call on this path — deliberately, and this is a change.
    // It used to fire unauthenticated and 401 every time (that was the L1
    // defect); authenticating it would not help, because the change-password
    // UPDATE stamps tokens_not_before = NOW(), and BOTH middleware/auth.ts
    // and POST /auth/refresh (routes/auth.ts:581-595, guard branch) reject
    // every token minted before that stamp. So the access token is dead, the
    // refresh token is dead, and the refresh-and-retry inside _authedRequest
    // is dead too. An nbf stamp is strictly stronger than a jti revoke — it
    // invalidates the whole session, not two specific tokens. Calling anyway
    // would spend a rate-limited /api/auth request on a guaranteed 401 and
    // now raise a Sentry warning for a session that is already fully revoked.
    await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)));
    set({ status: 'unauthenticated', guardId: null, companyId: null, mustChangePassword: false });
    setUserTags({ guardId: null, companyId: null });
  },

  forgotPassword: async (email) => {
    // Was a second hand-rolled copy of _request. Same endpoint shape, same
    // error handling — deduped so both auth paths classify identically.
    await _request('/auth/forgot-password', {
      email: email.toLowerCase().trim(),
      portal: 'guard',
    });
  },

  logout: async (opts) => {
    // Single-flight: N concurrent 401s (home mount volley, queue sync,
    // AppState refetch) each used to fire their own logout — N fcm-null +
    // N /auth/logout requests against the shared /api/auth rate limit.
    // Everyone now awaits the same teardown.
    if (pendingLogout) return pendingLogout;
    pendingLogout = (async () => {
      const tokenRevoked = opts?.tokenRevoked ?? false;

      // State first: every automatic retry loop (home.restoreOrFetchShift,
      // offlineStore callers) gates on status === 'authenticated', so
      // flipping it before anything async stops the storm immediately.
      set({ status: 'unauthenticated', guardId: null, companyId: null, mustChangePassword: false });

      // Stop background work that needs auth: the 60s offline-queue sync,
      // and the shift cache — clearing activeSession trips the root-layout
      // geofence gate, which disarms native region monitoring and wipes
      // the background task's SecureStore session keys.
      stopQueueSync();
      useShiftStore.getState().clearSession();

      // Only a presence check — _authedRequest re-reads the token itself, and
      // may rotate it. Nothing below may capture a token value in a local:
      // after a rotation the captured copy is the one the server just revoked.
      const access = await SecureStore.getItemAsync(KEYS.ACCESS);

      if (!tokenRevoked) {
        // Bug Y — null the guard's fcm_token BEFORE clearing local auth
        // state so this request is still authenticated. The server
        // relaxed /auth/guard/fcm-token to accept explicit null; without
        // this, a logged-out phone keeps receiving pushes because the DB
        // still holds its Expo token. Still best-effort — a network failure
        // here must not block logout (L1.3) — but no longer silent.
        if (access) {
          try {
            await _authedRequest('/auth/guard/fcm-token', async () => ({ fcm_token: null }));
            Sentry.addBreadcrumb({
              category: 'auth',
              message: 'fcm-token null-on-logout sent',
              level: 'info',
            });
          } catch (err) {
            // Was a bare fetch whose try/catch only caught TRANSPORT errors —
            // a 401/500 RESPONSE resolved normally and still breadcrumbed
            // "sent", so a null-write that never landed looked identical to
            // one that did. _authedRequest throws ApiError on non-2xx, so the
            // two are now distinguishable. captureMessage, not just a
            // breadcrumb: a token left on the row is the whole cross-account
            // push defect, and it has to be visible without a paired crash.
            Sentry.captureMessage('fcm-token null-on-logout failed', {
              level: 'warning',
              tags: { flow: 'logout' },
              extra: {
                message: (err as Error)?.message,
                status:  (err as { status?: number })?.status ?? null,
              },
            });
          }
        }

        try {
          // refresh_token is re-read inside the factory, not captured from the
          // outer scope: if the fcm-null call above hit a 401 and rotated the
          // pair, the outer `refresh` is the jti the rotation already revoked.
          // Sending it would 200 (the server treats a duplicate revoke as a
          // valid end state) while leaving the LIVE refresh token unrevoked —
          // the exact hole this phase exists to close.
          await _authedRequest('/auth/logout', async () => ({
            refresh_token: await SecureStore.getItemAsync(KEYS.REFRESH),
          }));
          Sentry.addBreadcrumb({
            category: 'auth',
            message: 'server logout accepted — access + refresh jti revoked',
            level: 'info',
          });
        } catch (err) {
          // L1.3: local state is torn down regardless — a guard must always be
          // able to sign out of the handset, and blocking on a dead network
          // would strand them on a session they have already left. But the
          // failure is no longer silent: it means the refresh token is still
          // live server-side until natural expiry, which is a real exposure
          // and has to be visible in the issues feed rather than swallowed by
          // `catch { /* best-effort */ }`.
          Sentry.captureMessage('server logout failed — refresh token still live', {
            level: 'warning',
            tags: { flow: 'logout' },
            extra: {
              message: (err as Error)?.message,
              status:  (err as { status?: number })?.status ?? null,
            },
          });
        }
      }
      // tokenRevoked: skip both calls. The nbf stamp already invalidated
      // access + refresh server-side, and a dead bearer's fcm-null POST is
      // just a 401 that counts against the guard's login budget.

      await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)));
      setUserTags({ guardId: null, companyId: null });

      if (tokenRevoked) {
        // The root layout's plain replace('/(auth)/login') may fire first
        // off the status flip; this replace lands last and carries the
        // notice param. Runs only on the revoked path — user-initiated
        // logout and the change-password flow route without a notice /
        // with their own notice respectively.
        router.replace('/(auth)/login?notice=session-expired');
      }
    })().finally(() => { pendingLogout = null; });
    return pendingLogout;
  },

  loadSession: async () => {
    // Must run BEFORE reading tokens: on a fresh install this wipes any
    // stale Keychain state left behind by the previous install.
    await nukeSecureStoreOnFreshInstall();
    const access = await SecureStore.getItemAsync(KEYS.ACCESS);
    if (!access) { set({ status: 'unauthenticated' }); return; }

    // One-shot Keychain rewrite for pre-Build-37 installs. If the marker
    // is unset AND both tokens are readable, _saveSession them back so
    // KEYCHAIN_OPTS (AFTER_FIRST_UNLOCK) sticks. A failure here must not
    // block loadSession — leave the marker unset so the next launch
    // retries.
    try {
      const migrated = await AsyncStorage.getItem(KEYCHAIN_MIGRATION_KEY);
      if (!migrated) {
        const refresh = await SecureStore.getItemAsync(KEYS.REFRESH);
        if (refresh) {
          await _saveSession({ access, refresh });
          await AsyncStorage.setItem(KEYCHAIN_MIGRATION_KEY, '1');
          Sentry.captureMessage('keychain migrated', 'info');
        } else {
          Sentry.captureMessage('keychain migration skipped: no refresh', 'warning');
        }
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { flow: 'keychain_migration' } });
    }

    const payload = _decodeJwt(access);
    if (payload.exp * 1000 < Date.now()) {
      try {
        await refreshTokens();
        const fresh = await SecureStore.getItemAsync(KEYS.ACCESS);
        const freshPayload = _decodeJwt(fresh!);
        set({ status: 'authenticated', guardId: freshPayload.sub, companyId: freshPayload.company_id });
        setUserTags({ guardId: freshPayload.sub, companyId: freshPayload.company_id ?? null, role: freshPayload.role });
      } catch {
        set({ status: 'unauthenticated' });
      }
      return;
    }
    set({ status: 'authenticated', guardId: payload.sub, companyId: payload.company_id });
    setUserTags({ guardId: payload.sub, companyId: payload.company_id ?? null, role: payload.role });
  },
}));

// ── Private helpers ──────────────────────────────────────────────────────────

// The auth endpoints deliberately bypass apiClient: they carry no Bearer
// token and routing them through the 401-refresh path would recurse. They
// must still speak the shared error taxonomy, or every login and
// forgot-password failure lands in the "bug in our own code" bucket —
// guardMessage would discard the server's copy and file a Sentry issue for
// an ordinary wrong password.
async function _request(path: string, body: unknown) {
  const API_URL = process.env.EXPO_PUBLIC_API_URL;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    // ApiError carries status + code + the full body, so callers can branch
    // on the 423 lockout without pattern-matching the message prose.
    throw new ApiError(res.status, err);
  }
  return res.json();
}

/**
 * _request's authenticated sibling: same error taxonomy, plus a Bearer token
 * and a single refresh-and-retry.
 *
 * Why not just add the header to _request: its other two callers are
 * /auth/guard/login and /auth/forgot-password, which are unauthenticated by
 * definition. Attaching a bearer there would send the PREVIOUS session's token
 * to a login endpoint — harmless to the server, but exactly the reflex that
 * produced the cross-account push incident, and not something to normalise.
 *
 * Why not route these through apiClient: its 401 retry replays the SAME body
 * value it was handed — `return request(method, path, body, options, false)`
 * at lib/apiClient.ts:124, after the refresh at :108. For /auth/logout the
 * body carries the refresh token, and the refresh it just did ROTATED that
 * token. apiClient would resend the pre-rotation jti; the server revokes an
 * already-revoked jti, treats it as a valid end state, and answers 200 — while
 * the live refresh token stays valid for its full 30 days. A silent no-op that
 * looks exactly like success. That is the failure this phase exists to close,
 * so the retry has to rebuild the body, and apiClient cannot.
 *
 * (Secondary: apiClient's definitive-rejection path fires
 * logout({ tokenRevoked: true }) at :116, which routes to
 * /(auth)/login?notice=session-expired — the wrong copy for a sign-out the
 * guard just asked for. It is `void`-ed, so it would not deadlock the
 * single-flight, but it would still hijack the screen.)
 *
 * Hence buildBody as a factory rather than a value: the retry re-runs it AFTER
 * the rotation and picks up the live refresh token.
 */
async function _authedRequest(path: string, buildBody: () => Promise<unknown>) {
  const API_URL = process.env.EXPO_PUBLIC_API_URL;

  const send = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await fetch(`${API_URL}/api${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(await buildBody()),
      });
    } catch (cause) {
      throw new NetworkError(cause);
    }
  };

  let res = await send(await SecureStore.getItemAsync(KEYS.ACCESS));

  // A 401 here is usually just an expired access token on a handset that has
  // been idle — the common case for "open the app after a shift, tap sign
  // out". Rotate once and resend, so the logout actually revokes rather than
  // leaving the refresh token live until natural expiry. If the refresh is
  // itself rejected the session is already dead server-side, which is the
  // outcome we wanted; fall through and let the caller tear down locally.
  if (res.status === 401) {
    try {
      await refreshTokens();
      res = await send(await SecureStore.getItemAsync(KEYS.ACCESS));
    } catch {
      /* leave `res` as the 401; the throw below reports it */
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new ApiError(res.status, err);
  }
  return res.json();
}

// Build 37: AFTER_FIRST_UNLOCK lets background tasks (native geofencing
// Exit handler in tasks/locationBackground.ts) read these items while
// the phone is screen-locked but has been unlocked at least once since
// boot. The default WHEN_UNLOCKED threw "User interaction not allowed"
// on Vishnu's July walk-test, silently killing the geofence-Exit POST.
// Only affects FUTURE writes — existing entries retain their old
// accessibility until the guard logs out and back in.
const KEYCHAIN_OPTS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

async function _saveSession(data: { access: string; refresh: string }) {
  await SecureStore.setItemAsync(KEYS.ACCESS, data.access, KEYCHAIN_OPTS);
  await SecureStore.setItemAsync(KEYS.REFRESH, data.refresh, KEYCHAIN_OPTS);
  const p = _decodeJwt(data.access);
  await SecureStore.setItemAsync(KEYS.GUARD_ID, p.sub, KEYCHAIN_OPTS);
  if (p.company_id) await SecureStore.setItemAsync(KEYS.COMPANY_ID, p.company_id, KEYCHAIN_OPTS);
  Sentry.addBreadcrumb({
    category: 'auth',
    message: 'keychain: AFTER_FIRST_UNLOCK applied',
    level: 'info',
    data: { keys_written: p.company_id ? 4 : 3 },
  });
}

function _decodeJwt(token: string): Record<string, any> {
  return JSON.parse(atob(token.split('.')[1]));
}
