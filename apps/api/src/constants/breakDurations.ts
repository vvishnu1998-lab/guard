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

export function isBreakType(v: unknown): v is BreakType {
  return v === 'meal' || v === 'rest' || v === 'other';
}
