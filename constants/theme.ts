/**
 * Youmi Lens for iPad — design tokens.
 *
 * Brand language: ink navy, deep-blue actions, translucent glass cards,
 * rounded corners, soft shadows, and a cool atmospheric background.
 */

export const colors = {
  // ---- Brand palette ----
  ink: '#1A2642',
  // Deep navy — the primary action/button fill (calm, premium, not bright blue).
  navy: '#0B1F3A',
  accent: '#33415C',
  accentBright: '#0B1F3A',
  accentPressed: '#071629',
  accentGlow: 'rgba(11, 31, 58, 0.14)',
  deepNavy: '#0B1F3A',
  secondaryNavy: '#33415C',
  softIceWhite: '#F7F8FC',
  pearlWhite: '#FFFFFF',
  iceBlue: '#E4E6EB',
  mutedBlueGray: '#7B8496',
  recordingRed: '#E8414A',

  // ---- Semantic (light surfaces) ----
  // Calm, near-white off-white base — bright and academic, never SaaS blue.
  background: '#F7F8FC',
  backgroundMid: '#FAFAFC',
  backgroundCool: '#F3F4F8',
  backgroundLavender: '#F6F5F8',
  surface: 'rgba(255, 255, 255, 0.76)',
  surfaceMuted: 'rgba(11, 31, 58, 0.035)',
  glass: 'rgba(255, 255, 255, 0.66)',
  glassElevated: 'rgba(255, 255, 255, 0.76)',
  glassEdge: 'rgba(15, 31, 58, 0.08)',
  glassHighlight: 'rgba(255, 255, 255, 0.82)',

  textPrimary: '#1A2642',
  textSecondary: '#4A5878',
  textTertiary: '#8E9BBE',

  border: 'rgba(15, 31, 58, 0.075)',
  borderStrong: 'rgba(15, 31, 58, 0.12)',

  // ---- Semantic (navy surfaces) ----
  navySurface: '#0B1F3A',
  navyElevated: '#102A43',
  navyBorder: 'rgba(148, 163, 184, 0.18)',
  textOnNavy: '#F8FAFC',
  textOnNavyMuted: '#CBD5E1',

  // ---- States ----
  success: '#1EA86A',
  successTint: 'rgba(30, 168, 106, 0.14)',
  warning: '#B7791F',
  warningTint: 'rgba(183, 121, 31, 0.16)',
  recordingTint: 'rgba(232, 65, 74, 0.10)',
  iceTint: 'rgba(11, 31, 58, 0.055)',
  /** Faint navy used for the Y watermark on the hero card. */
  watermark: 'rgba(11, 31, 58, 0.04)',
  /** Paper colour + ruling for the mini-caption note background. */
  paper: '#FFFFFF',
  noteLine: '#E5E7EB',
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
  /** Standard card lift — soft and airy on the off-white base. */
  card: {
    shadowColor: '#0F1F3A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.055,
    shadowRadius: 28,
    elevation: 2,
  },
  /** Subtle lift for rows / small surfaces */
  soft: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.035,
    shadowRadius: 14,
    elevation: 1,
  },
  /** Primary button lift */
  button: {
    shadowColor: '#0B1F3A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 18,
    elevation: 4,
  },
  /** Floating mini-caption panel */
  float: {
    shadowColor: '#000000',
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
  workspacePadding: 38,
} as const;

export const theme = { colors, spacing, radius, fontSize, shadows, layout };

export default theme;
