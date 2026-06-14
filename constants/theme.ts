/**
 * Youmi Lens for iPad — design tokens.
 *
 * Brand language: ink navy, deep-blue actions, translucent glass cards,
 * rounded corners, soft shadows, and a cool atmospheric background.
 */

export const colors = {
  // ---- Brand palette ----
  ink: '#0F172A',
  navy: '#0B1F3A',
  accent: '#102A43',
  accentBright: '#0B1F3A',
  accentPressed: '#071629',
  accentGlow: 'rgba(11, 31, 58, 0.16)',
  deepNavy: '#071629',
  secondaryNavy: '#102A43',
  softIceWhite: '#F8FAFC',
  pearlWhite: '#FFFFFF',
  iceBlue: '#E5E7EB',
  mutedBlueGray: '#64748B',
  recordingRed: '#C2414B',

  // ---- Semantic (light surfaces) ----
  background: '#F8FAFC',
  backgroundMid: '#F5F7FB',
  backgroundCool: '#FFFFFF',
  backgroundLavender: '#F7F7F9',
  surface: '#FFFFFF',
  surfaceMuted: 'rgba(15, 23, 42, 0.045)',
  glass: 'rgba(255, 255, 255, 0.82)',
  glassElevated: 'rgba(255, 255, 255, 0.92)',
  glassEdge: 'rgba(15, 23, 42, 0.08)',
  glassHighlight: 'rgba(255, 255, 255, 0.96)',

  textPrimary: '#0F172A',
  textSecondary: '#475569',
  textTertiary: '#64748B',

  border: 'rgba(15, 23, 42, 0.08)',
  borderStrong: 'rgba(15, 23, 42, 0.14)',

  // ---- Semantic (navy surfaces) ----
  navySurface: '#0B1F3A',
  navyElevated: '#102A43',
  navyBorder: 'rgba(148, 163, 184, 0.18)',
  textOnNavy: '#F8FAFC',
  textOnNavyMuted: '#CBD5E1',

  // ---- States ----
  success: '#047857',
  successTint: 'rgba(4, 120, 87, 0.16)',
  warning: '#B7791F',
  warningTint: 'rgba(183, 121, 31, 0.16)',
  recordingTint: 'rgba(15, 23, 42, 0.055)',
  iceTint: 'rgba(15, 23, 42, 0.055)',
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
  /** Standard card lift */
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  /** Subtle lift for rows / small surfaces */
  soft: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  /** Primary button lift */
  button: {
    shadowColor: '#1E3A8A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 16,
    elevation: 6,
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
