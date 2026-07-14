import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setUserTags } from '../lib/sentry';

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
  logout: () => Promise<void>;
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
    const access = await SecureStore.getItemAsync(KEYS.ACCESS);
    if (!access) throw new Error('Not authenticated');
    const API_URL = process.env.EXPO_PUBLIC_API_URL;
    const res = await fetch(`${API_URL}/api/auth/guard/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Change password failed' }));
      throw new Error(err.error ?? 'Change password failed');
    }
    set({ mustChangePassword: false });
  },

  forgotPassword: async (email) => {
    const API_URL = process.env.EXPO_PUBLIC_API_URL;
    const res = await fetch(`${API_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase().trim(), portal: 'guard' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error ?? 'Request failed');
    }
  },

  logout: async () => {
    const access  = await SecureStore.getItemAsync(KEYS.ACCESS);
    const refresh = await SecureStore.getItemAsync(KEYS.REFRESH);

    // Bug Y — null the guard's fcm_token BEFORE clearing local auth
    // state so this request is still authenticated. The server
    // relaxed /auth/guard/fcm-token to accept explicit null; without
    // this, a logged-out phone keeps receiving pushes because the DB
    // still holds its Expo token. Best-effort — a network failure
    // here shouldn't block logout, but we breadcrumb it so we can
    // tell in Sentry whether the null-write landed.
    if (access) {
      try {
        await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/auth/guard/fcm-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
          body: JSON.stringify({ fcm_token: null }),
        });
        Sentry.addBreadcrumb({
          category: 'auth',
          message: 'fcm-token null-on-logout sent',
          level: 'info',
        });
      } catch (err) {
        Sentry.addBreadcrumb({
          category: 'auth',
          message: 'fcm-token null-on-logout failed',
          level: 'warning',
          data: { message: (err as Error)?.message },
        });
      }
    }

    try {
      await _request('/auth/logout', { refresh_token: refresh });
    } catch { /* best-effort */ }
    await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)));
    set({ status: 'unauthenticated', guardId: null, companyId: null, mustChangePassword: false });
    setUserTags({ guardId: null, companyId: null });
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
        await _refreshTokens();
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

async function _request(path: string, body: unknown) {
  const API_URL = process.env.EXPO_PUBLIC_API_URL;
  const res = await fetch(`${API_URL}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error ?? 'Request failed');
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

async function _refreshTokens() {
  const refresh = await SecureStore.getItemAsync(KEYS.REFRESH);
  if (!refresh) throw new Error('No refresh token');
  const API_URL = process.env.EXPO_PUBLIC_API_URL;
  const res = await fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!res.ok) throw new Error('Refresh failed');
  const data = await res.json();
  await _saveSession(data);
}

function _decodeJwt(token: string): Record<string, any> {
  return JSON.parse(atob(token.split('.')[1]));
}
