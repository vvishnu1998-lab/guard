import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { apiClient } from '../lib/apiClient';

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated' | 'locked';

interface AuthState {
  status: AuthStatus;
  guardId: string | null;
  companyId: string | null;
  mustChangePassword: boolean;
  isLocked: boolean; // app-level auto-lock (5 min inactivity)

  // Actions
  loginWithEmail: (email: string, password: string) => Promise<void>;
  loginWithBadge: (badgeNumber: string, pin: string) => Promise<void>;
  loginWithBiometric: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  unlock: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
  loadSession: () => Promise<void>;
  lockApp: () => void;
}

const KEYS = {
  ACCESS:  'guard_access_token',
  REFRESH: 'guard_refresh_token',
  GUARD_ID: 'guard_id',
  COMPANY_ID: 'guard_company_id',
  PIN_HASH: 'guard_pin_hash',  // hashed PIN stored for offline auto-lock unlock
};

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'unknown',
  guardId: null,
  companyId: null,
  mustChangePassword: false,
  isLocked: false,

  loginWithEmail: async (email, password) => {
    const data = await apiClient.post('/auth/guard/login', { email, password });
    await _saveSession(data);
    set({
      status: 'authenticated',
      guardId: data.guard_id ?? _decodeJwt(data.access).sub,
      companyId: _decodeJwt(data.access).company_id,
      mustChangePassword: data.must_change_password ?? false,
      isLocked: false,
    });
  },

  loginWithBadge: async (badgeNumber, pin) => {
    const data = await apiClient.post('/auth/guard/badge', { badge_number: badgeNumber, pin });
    await _saveSession(data);
    set({
      status: 'authenticated',
      guardId: _decodeJwt(data.access).sub,
      companyId: _decodeJwt(data.access).company_id,
      mustChangePassword: data.must_change_password ?? false,
      isLocked: false,
    });
  },

  loginWithBiometric: async () => {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!compatible || !enrolled) throw new Error('Biometrics not available');

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Verify your identity to sign in',
      fallbackLabel: 'Use PIN',
      cancelLabel: 'Cancel',
    });
    if (!result.success) throw new Error('Biometric authentication failed');

    // Biometric succeeds → restore session from SecureStore (tokens already saved)
    const access = await SecureStore.getItemAsync(KEYS.ACCESS);
    if (!access) throw new Error('No session found — please sign in with password');

    const payload = _decodeJwt(access);
    if (payload.exp * 1000 < Date.now()) {
      // Access token expired — try refresh
      await _refreshTokens();
    }
    const freshAccess = await SecureStore.getItemAsync(KEYS.ACCESS);
    const freshPayload = _decodeJwt(freshAccess!);
    set({
      status: 'authenticated',
      guardId: freshPayload.sub,
      companyId: freshPayload.company_id,
      isLocked: false,
    });
  },

  changePassword: async (current, next) => {
    await apiClient.post('/auth/guard/change-password', {
      current_password: current,
      new_password: next,
    });
    set({ mustChangePassword: false });
  },

  /** Unlock the auto-locked app using PIN (biometric fallback) */
  unlock: async (pin) => {
    // In dev/simulator, skip biometrics to avoid passcode fallback loop
    if (__DEV__) {
      set({ isLocked: false });
      return;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Guard',
      fallbackLabel: 'Use PIN',
    });
    if (!result.success) throw new Error('Authentication failed');
    set({ isLocked: false });
  },

  lockApp: () => set({ isLocked: true }),

  logout: async () => {
    const refresh = await SecureStore.getItemAsync(KEYS.REFRESH);
    try {
      await apiClient.post('/auth/logout', { refresh_token: refresh });
    } catch { /* best-effort */ }
    await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)));
    set({ status: 'unauthenticated', guardId: null, companyId: null, isLocked: false });
  },

  loadSession: async () => {
    const access = await SecureStore.getItemAsync(KEYS.ACCESS);
    if (!access) { set({ status: 'unauthenticated' }); return; }

    const payload = _decodeJwt(access);
    if (payload.exp * 1000 < Date.now()) {
      try {
        await _refreshTokens();
        const fresh = await SecureStore.getItemAsync(KEYS.ACCESS);
        const freshPayload = _decodeJwt(fresh!);
        set({ status: 'authenticated', guardId: freshPayload.sub, companyId: freshPayload.company_id });
      } catch {
        set({ status: 'unauthenticated' });
      }
      return;
    }
    set({ status: 'authenticated', guardId: payload.sub, companyId: payload.company_id });
  },
}));

// ── Private helpers ──────────────────────────────────────────────────────────

async function _saveSession(data: { access: string; refresh: string }) {
  await SecureStore.setItemAsync(KEYS.ACCESS, data.access);
  await SecureStore.setItemAsync(KEYS.REFRESH, data.refresh);
  const p = _decodeJwt(data.access);
  await SecureStore.setItemAsync(KEYS.GUARD_ID, p.sub);
  if (p.company_id) await SecureStore.setItemAsync(KEYS.COMPANY_ID, p.company_id);
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
