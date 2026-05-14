import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  guardId: string | null;
  companyId: string | null;
  mustChangePassword: boolean;

  // Actions
  loginWithEmail: (email: string, password: string) => Promise<void>;
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

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  guardId: null,
  companyId: null,
  mustChangePassword: false,

  loginWithEmail: async (email, password) => {
    const data = await _request('/auth/guard/login', { email, password });
    await _saveSession(data);
    set({
      status: 'authenticated',
      guardId: data.guard_id ?? _decodeJwt(data.access).sub,
      companyId: _decodeJwt(data.access).company_id,
      mustChangePassword: data.must_change_password ?? false,
    });
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
    const refresh = await SecureStore.getItemAsync(KEYS.REFRESH);
    try {
      await _request('/auth/logout', { refresh_token: refresh });
    } catch { /* best-effort */ }
    await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)));
    set({ status: 'unauthenticated', guardId: null, companyId: null, mustChangePassword: false });
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
