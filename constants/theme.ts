/**
 * Youmi Lens for iPad — design tokens.
 *
 * Brand language: deep navy, pearl/ice whites, frosted glass cards,
 * rounded corners, soft shadows, thin borders, calm and professional.
 * No purple, no bright gradients.
 */

export const colors = {
  // ---- Brand palette ----
  deepNavy: '#061B34',
  secondaryNavy: '#0A2342',
  softIceWhite: '#F6F9FC',
  pearlWhite: '#FFFFFF',
  iceBlue: '#DCEAF7',
  mutedBlueGray: '#7A8CA3',
  recordingRed: '#EF4444',

  // ---- Semantic (light surfaces) ----
  background: '#F6F9FC',
  surface: '#FFFFFF',
  surfaceMuted: '#EEF3F9',
  glass: 'rgba(255, 255, 255, 0.74)',
  glassEdge: 'rgba(255, 255, 255, 0.9)',

  textPrimary: '#061B34',
  textSecondary: '#5C6E85',
  textTertiary: '#7A8CA3',

  border: '#E4ECF5',
  borderStrong: '#D4E1EF',

  // ---- Semantic (navy surfaces) ----
  navySurface: '#0A2342',
  navyElevated: '#103056',
  navyBorder: 'rgba(220, 234, 247, 0.14)',
  textOnNavy: '#FFFFFF',
  textOnNavyMuted: '#A9BBD0',

  // ---- States ----
  success: '#1FA97A',
  successTint: '#E4F4EE',
  recordingTint: '#FDECEC',
  iceTint: '#EAF2FB',
  /** Faint navy used for the Y watermark on the hero card. */
  watermark: 'rgba(6, 27, 52, 0.05)',
  /** Paper colour + ruling for the mini-caption note background. */
  paper: '#FCFDFE',
  noteLine: '#E7EDF4',
  noteMargin: 'rgba(196, 132, 132, 0.35)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 28,
  pill: 999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 26,
  hero: 29,
  display: 34,
  caption: 23,
  timer: 58,
} as const;

export const shadows = {
  /** Standard card lift */
  card: {
    shadowColor: '#0A2342',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 4,
  },
  /** Subtle lift for rows / small surfaces */
  soft: {
    shadowColor: '#0A2342',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  /** Primary button lift */
  button: {
    shadowColor: '#061B34',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 16,
    elevation: 6,
  },
  /** Floating mini-caption panel */
  float: {
    shadowColor: '#061B34',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.32,
    shadowRadius: 38,
    elevation: 14,
  },
} as const;

export const layout = {
  /** Centred reading width — keeps content calm on wide iPad landscape. */
  content: 760,
  /** Slightly wider for grid-ish screens. */
  wide: 1040,
} as const;

export const theme = { colors, spacing, radius, fontSize, shadows, layout };

export default theme;
