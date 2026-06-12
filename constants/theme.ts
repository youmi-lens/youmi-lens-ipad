/**
 * Youmi Lens for iPad — design tokens.
 *
 * Brand language: ink navy, deep-blue actions, translucent glass cards,
 * rounded corners, soft shadows, and a cool atmospheric background.
 */

export const colors = {
  // ---- Brand palette ----
  ink: '#1A2642',
  navy: '#2B3A5C',
  accent: '#1D3E8A',
  accentBright: '#2B52C8',
  accentGlow: 'rgba(29, 62, 138, 0.24)',
  deepNavy: '#1D3E8A',
  secondaryNavy: '#2B3A5C',
  softIceWhite: '#F6F8FF',
  pearlWhite: '#FFFFFF',
  iceBlue: '#C8D7F5',
  mutedBlueGray: '#8E9BBE',
  recordingRed: '#E8414A',

  // ---- Semantic (light surfaces) ----
  background: '#EEF2FC',
  backgroundMid: '#F6F8FF',
  backgroundCool: '#E8F0FA',
  backgroundLavender: '#F0EEF8',
  surface: '#FFFFFF',
  surfaceMuted: 'rgba(29, 62, 138, 0.06)',
  glass: 'rgba(255, 255, 255, 0.72)',
  glassElevated: 'rgba(255, 255, 255, 0.88)',
  glassEdge: 'rgba(200, 215, 245, 0.55)',
  glassHighlight: 'rgba(255, 255, 255, 0.90)',

  textPrimary: '#1A2642',
  textSecondary: '#4A5878',
  textTertiary: '#8E9BBE',

  border: 'rgba(200, 215, 245, 0.55)',
  borderStrong: 'rgba(29, 62, 138, 0.18)',

  // ---- Semantic (navy surfaces) ----
  navySurface: '#2B3A5C',
  navyElevated: '#35466C',
  navyBorder: 'rgba(220, 234, 247, 0.14)',
  textOnNavy: '#FFFFFF',
  textOnNavyMuted: '#A9BBD0',

  // ---- States ----
  success: '#1EA86A',
  successTint: 'rgba(30, 168, 106, 0.12)',
  recordingTint: 'rgba(232, 65, 74, 0.10)',
  iceTint: 'rgba(29, 62, 138, 0.10)',
  /** Faint navy used for the Y watermark on the hero card. */
  watermark: 'rgba(29, 62, 138, 0.05)',
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
  md: 13,
  lg: 16,
  xl: 20,
  xxl: 28,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 16,
  xl: 20,
  xxl: 22,
  hero: 27,
  display: 27,
  caption: 23,
  timer: 58,
} as const;

export const shadows = {
  /** Standard card lift */
  card: {
    shadowColor: '#1E3264',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
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
    shadowColor: '#1D3E8A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
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
  sidebar: 232,
} as const;

export const theme = { colors, spacing, radius, fontSize, shadows, layout };

export default theme;
