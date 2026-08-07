/**
 * Break duration source of truth (mobile side).
 *
 * KEEP IN SYNC with apps/api/src/constants/breakDurations.ts. Server derives
 * planned_duration_minutes from break_type via the same map on
 * POST /shifts/break-start; mobile keeps this local copy so BREAK_OPTIONS
 * in apps/mobile/app/break/index.tsx (labels + icons) references the same
 * numbers and doesn't drift. Any duration change MUST land on both sides
 * in the same batch.
 */
export type BreakType = 'meal' | 'rest' | 'other';

export const BREAK_DURATIONS: Record<BreakType, number> = {
  meal:  30,
  rest:  15,
  other: 10,
};
