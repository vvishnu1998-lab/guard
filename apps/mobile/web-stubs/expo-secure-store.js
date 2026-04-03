/**
 * Web stub for expo-secure-store.
 * On web there is no secure enclave — we use localStorage as a best-effort
 * fallback. This is fine for dev/QA testing; production runs on native only.
 */

const PREFIX = '__guard_secure_';

export async function getItemAsync(key, _options) {
  try {
    return localStorage.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

export async function setItemAsync(key, value, _options) {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // ignore quota/security errors in web sandbox
  }
}

export async function deleteItemAsync(key, _options) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {}
}

export async function isAvailableAsync() {
  return typeof localStorage !== 'undefined';
}

export const AFTER_FIRST_UNLOCK = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const ALWAYS_THIS_DEVICE_ONLY = 4;
export const WHEN_UNLOCKED = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;
