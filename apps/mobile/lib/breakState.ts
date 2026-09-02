/**
 * Persisted break state — the single source of truth shared by foreground
 * screens and the headless geofence background task
 * (tasks/locationBackground.ts), which cannot see the in-memory zustand
 * stores.
 *
 * One key, `active_break_until`, holding the ISO instant the break's
 * PLANNED window ends (break_start + planned_duration_minutes). Carrying
 * the end time makes the key self-expiring: the server auto-closes every
 * break at its planned end (breakExpiryCron — "auto-close at plan"), and a
 * backgrounded or killed app never hears about it, so a plain boolean flag
 * would stay stale-open forever. isBreakActive() comparing against NOW
 * needs no server round-trip and can never outlive the server's own break.
 *
 * Written under AFTER_FIRST_UNLOCK (matching authStore / refreshManager
 * KEYCHAIN_OPTS) so the background task can read it from a locked phone —
 * the geofence-Exit handler is precisely the reader that runs while the
 * screen is off.
 *
 * Failure direction: every helper fails toward ENFORCEMENT (break not
 * active). A Keychain read error or corrupt value must never be the reason
 * a genuine breach goes unreported; the worst case of failing this way is
 * one spurious alert during a break, which the server (break-quiet policy,
 * main 99d09bd) suppresses anyway.
 */
import * as SecureStore from 'expo-secure-store';

export const ACTIVE_BREAK_UNTIL_KEY = 'active_break_until';

const KEYCHAIN_OPTS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

/** Persist the planned end of the active break. Fire-and-forget safe. */
export async function persistBreakUntil(
  breakStartIso: string,
  plannedMinutes: number,
): Promise<void> {
  const untilMs = new Date(breakStartIso).getTime() + plannedMinutes * 60_000;
  if (!Number.isFinite(untilMs)) return;
  await SecureStore.setItemAsync(
    ACTIVE_BREAK_UNTIL_KEY,
    new Date(untilMs).toISOString(),
    KEYCHAIN_OPTS,
  ).catch(() => {});
}

/** Clear on break end / session teardown. Fire-and-forget safe. */
export async function clearBreakUntil(): Promise<void> {
  await SecureStore.deleteItemAsync(ACTIVE_BREAK_UNTIL_KEY).catch(() => {});
}

/**
 * True while a persisted break is inside its planned window. Self-expires
 * at the planned end even if the key was never cleared (killed app,
 * server auto-close the app never saw).
 */
export async function isBreakActive(nowMs: number = Date.now()): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(ACTIVE_BREAK_UNTIL_KEY);
    if (!raw) return false;
    const untilMs = Date.parse(raw);
    if (!Number.isFinite(untilMs)) return false;
    return nowMs < untilMs;
  } catch {
    return false;
  }
}
