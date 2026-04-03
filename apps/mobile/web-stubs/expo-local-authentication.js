/**
 * Web stub for expo-local-authentication.
 * Biometrics are not available in a browser — always reports unsupported,
 * so the app falls back to PIN/password login on web.
 */

export async function hasHardwareAsync() {
  return false;
}

export async function isEnrolledAsync() {
  return false;
}

export async function supportedAuthenticationTypesAsync() {
  return [];
}

export async function authenticateAsync(_options) {
  return { success: false, error: 'not_available', warning: 'Biometrics are not supported on web.' };
}

export async function getEnrolledLevelAsync() {
  return 0;
}

export async function cancelAuthenticate() {}
