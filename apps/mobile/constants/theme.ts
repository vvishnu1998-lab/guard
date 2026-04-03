/**
 * Precision Field design language (Section 8)
 * Barlow Condensed headings, warm off-white base, deep charcoal structure, amber action
 */
export const Colors = {
  base: '#F5F3EE',        // warm off-white background
  structure: '#1A1A2E',   // deep charcoal
  action: '#F59E0B',      // amber — single action color
  surface: '#242436',     // slightly lighter charcoal for cards
  danger: '#EF4444',      // red — incidents, violations, clock-out
  info: '#3B82F6',        // blue — GPS only pings
  success: '#10B981',     // green — confirmations
  muted: '#6B7280',       // subdued text
  border: '#2E2E48',      // subtle borders
  white: '#FFFFFF',
  black: '#000000',
} as const;

export const Fonts = {
  heading: 'BarlowCondensed_700Bold',
  headingMedium: 'BarlowCondensed_500Medium',
  body: 'System',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const Radius = {
  xs: 4,
  sm: 6,
  md: 12,
  lg: 20,
  full: 9999,
} as const;
