/**
 * V-Wing design language — deep navy + cyan accent
 */
export const Colors = {
  bg: '#070D1A',            // deep navy background
  surface: '#0F1929',       // card surface
  surface2: '#172035',      // elevated cards
  border: '#1E3A5F',        // subtle borders
  action: '#00C8FF',        // V-Wing cyan — primary accent
  success: '#00E5A0',       // green confirmations
  danger: '#EF4444',        // red — incidents, violations, clock-out
  warning: '#F59E0B',       // amber — GPS markers, warnings
  info: '#3B82F6',          // blue
  textPrimary: '#FFFFFF',   // primary text
  muted: '#8899AA',         // subdued text
  white: '#FFFFFF',
  black: '#000000',

  // Legacy aliases kept for backward-compatibility with existing screens
  base: '#FFFFFF',
  structure: '#070D1A',
  surface_card: '#0F1929',
  border_card: '#1E3A5F',
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
