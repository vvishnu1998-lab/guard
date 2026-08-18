/**
 * Break duration source of truth.
 *
 * Keep in sync with apps/mobile/app/break/index.tsx BREAK_OPTIONS. Server
 * derives planned_duration_minutes from break_type via this map; mobile
 * uses its BREAK_OPTIONS for labels + icons + the same duration numbers.
 * Any change here MUST land on the mobile side in the same batch.
 */
export type BreakType = 'meal' | 'rest' | 'other';

export const BREAK_DURATIONS: Record<BreakType, number> = {
  meal:  30,
  rest:  15,
  other: 10,
};

/**
 * Per-shift-session break allowance by type (2026-08-18, approved).
 * rest: 2 tracks California rest-break guidance for 10-hour overnights.
 * Enforced at break-start; mirrored on the mobile break screen ("Lunch 1/2").
 */
export const BREAK_QUOTAS: Record<BreakType, number> = {
  meal:  1,
  rest:  2,
  other: 2,
};

/**
 * A break whose break_end lands within this many seconds of its
 * break_start is a mis-tap: it does not burn quota. Chosen over a
 * duration_minutes=0 test because duration is computed at CLOSE and
 * cannot gate a check at START; a start-then-immediately-end also
 * cannot farm allowance this way.
 */
export const BREAK_MISTAP_SECONDS = 60;

export function isBreakType(v: unknown): v is BreakType {
  return v === 'meal' || v === 'rest' || v === 'other';
}
