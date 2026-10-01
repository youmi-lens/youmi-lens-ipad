/**
 * PK4-B — narrow shared toolbar chrome: the rendering half (pure logic +
 * tokens live in lib/sharedToolbarChrome.ts, which this file builds on).
 *
 * Contains ONLY the toolbar chrome verified byte-identical, today, between
 * components/NotebookCanvas.tsx's toolbar and components/
 * MaterialFloatingToolbar.tsx: the navy gradient surface, the drag-grip
 * dots, and the subset of glyph icons whose SVG path data matches exactly in
 * both files. It does NOT attempt to unify the toolbars themselves — their
 * tool sets, Undo/Redo placement, and vertical-dock layouts have genuinely
 * diverged (see the PK4-B report) and stay exactly as they are.
 *
 * Neither NotebookCanvas.tsx nor MaterialFloatingToolbar.tsx imports this
 * yet. Wiring either of them to consume it is deferred to a follow-up pass
 * that can actually run the build/typecheck/test/install validation cycle
 * end to end (see the PK4-B report for why that didn't happen this turn).
 */
import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { TOOLBAR_NAVY_BOTTOM, TOOLBAR_NAVY_TOP } from '@/lib/sharedToolbarChrome';

/** Vertical navy gradient fill — verified identical (in effect) to both
 * Notebook's `NavySurfaceBase` (a sized `Rect`) and Course Material's
 * `NavySurfaceBase` (an oversized `Path` clipped by the parent's
 * `overflow: hidden`): both just paint the same two-stop gradient across
 * the full container. This uses Notebook's cleaner, explicitly-sized `Rect`
 * form, which renders pixel-identically for Material's no-args call site
 * (defaults to `100%`, exactly like Material's fixed absolute-fill usage). */
export function NavySurface({
  width,
  height,
}: {
  width?: number | string;
  height?: number | string;
}) {
  const gradientId = useId().replace(/:/g, '_');
  const surfaceWidth = width ?? '100%';
  const surfaceHeight = height ?? '100%';
  return (
    <View style={styles.navySurfaceLayer} pointerEvents="none">
      <Svg width={surfaceWidth} height={surfaceHeight} style={StyleSheet.absoluteFillObject}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={TOOLBAR_NAVY_TOP} />
            <Stop offset="1" stopColor={TOOLBAR_NAVY_BOTTOM} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={surfaceWidth} height={surfaceHeight} fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
}

/** Drag-handle grip — two columns of three 3pt dots. Verified identical
 * style values in both NotebookCanvas.tsx's and MaterialFloatingToolbar.tsx's
 * `gripDots`/`gripCol`/`gripDot` styles. */
export function ToolbarGripDots() {
  return (
    <View style={styles.gripDots}>
      <View style={styles.gripCol}>
        <View style={styles.gripDot} />
        <View style={styles.gripDot} />
        <View style={styles.gripDot} />
      </View>
      <View style={styles.gripCol}>
        <View style={styles.gripDot} />
        <View style={styles.gripDot} />
        <View style={styles.gripDot} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  navySurfaceLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  gripDots: {
    flexDirection: 'row',
    gap: 3,
  },
  gripCol: {
    gap: 3,
  },
  gripDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
});

/** Glyph names whose SVG path data is verified byte-identical between
 * Notebook's `ToolbarGlyphBase` (name `'type'` there) and Material's
 * `GlyphBase` (name `'text'` there) — and, for every other name here, both
 * files already use the same name. Every other glyph either file has
 * (Notebook's select/insert/duplicate/trash/more/chevronDown; Material has
 * no extras) is genuinely local to that file and stays there. */
export type SharedToolbarGlyphName =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'text'
  | 'undo'
  | 'redo'
  | 'hand'
  | 'more'
  | 'trash'
  | 'chevronUp'
  | 'chevronLeft'
  | 'chevronRight';

/** Renders just the `<Path>` children for a shared glyph, viewBox `0 0 28 28`
 * (matching both files' `<Svg>` wrapper) — a caller supplies its own `<Svg>`
 * so this only ever replaces the identical inner paths, never the two
 * files' (currently identical, but independently owned) outer glyph
 * components. */
export function SharedToolbarGlyphPaths({
  name,
  color,
}: {
  name: SharedToolbarGlyphName;
  color: string;
}) {
  const outline = {
    stroke: color,
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  switch (name) {
    case 'more':
    case 'trash':
      return <Path d="M7 9h14M11 9V7.5a1.2 1.2 0 0 1 1.2-1.2h3.6a1.2 1.2 0 0 1 1.2 1.2V9M9 9v12.5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9" {...outline} />;
    case 'pen':
      return (
        <>
          <Path d="M5 23l1.4-4.6L19 5.8a2.3 2.3 0 0 1 3.3 3.3L9.6 21.6 5 23Z" {...outline} />
          <Path d="M16.6 8.2l3.2 3.2" stroke={color} strokeWidth={1.9} fill="none" />
          <Path d="M5 23l1.4-4.6 3.2 3.2L5 23Z" fill={color} />
        </>
      );
    case 'highlighter':
      return (
        <>
          <Path d="M6 20l-1.2 3.4 3.4-1.2L20 9.4l-2.2-2.2L6 20Z" {...outline} />
          <Path
            d="M17.8 7.2l2.2 2.2 2.2-2.2a1.55 1.55 0 0 0 0-2.2a1.55 1.55 0 0 0-2.2 0L17.8 7.2Z"
            fill={color}
          />
          <Path d="M5 24h6.5" stroke={color} strokeWidth={2} strokeLinecap="round" fill="none" />
        </>
      );
    case 'eraser':
      return (
        <>
          <Path d="M9 22h12" stroke={color} strokeWidth={1.9} strokeLinecap="round" fill="none" />
          <Path
            d="M6.2 18.4l-1.6-1.6a2.2 2.2 0 0 1 0-3.1l7.6-7.6a2.2 2.2 0 0 1 3.1 0l4.4 4.4a2.2 2.2 0 0 1 0 3.1L15 20.4H8.6L6.2 18.4Z"
            {...outline}
          />
          <Path d="M10 9.6l5.6 5.6" stroke={color} strokeWidth={1.9} fill="none" />
        </>
      );
    case 'text':
      return (
        <>
          <Path
            d="M6 8h11M6 8V6.5M17 8V6.5M11.5 8v14M9 22h5"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <Path
            d="M17 12h6M20 12v10M18.5 22h3"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
            fill="none"
          />
        </>
      );
    case 'undo':
      return (
        <>
          <Path
            d="M10 8L6 12l4 4"
            stroke={color}
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <Path
            d="M6 12h10.5a5.5 5.5 0 0 1 5.5 5.5v1"
            stroke={color}
            strokeWidth={1.9}
            strokeLinecap="round"
            fill="none"
          />
        </>
      );
    case 'redo':
      return (
        <>
          <Path
            d="M18 8l4 4-4 4"
            stroke={color}
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <Path
            d="M22 12H11.5A5.5 5.5 0 0 0 6 17.5v1"
            stroke={color}
            strokeWidth={1.9}
            strokeLinecap="round"
            fill="none"
          />
        </>
      );
    case 'hand':
      return (
        <Path
          d="M11 13V7.5a1.7 1.7 0 0 1 3.4 0V13m0-1.5a1.7 1.7 0 0 1 3.4 0V14m0-1a1.7 1.7 0 0 1 3.3 0v4.5c0 3.3-2.4 5.8-6 5.8-2.4 0-4-1-5.4-2.8l-3-4a1.7 1.7 0 0 1 2.5-2.2L11 17V13Z"
          stroke={color}
          strokeWidth={1.7}
          strokeLinejoin="round"
          fill="none"
        />
      );
    case 'chevronUp':
      return (
        <Path
          d="M7 17.5l7-7 7 7"
          stroke={color}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      );
    case 'chevronLeft':
      return (
        <Path
          d="M17 7l-6 7 6 7"
          stroke={color}
          strokeWidth={2.1}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      );
    case 'chevronRight':
      return (
        <Path
          d="M11 7l6 7-6 7"
          stroke={color}
          strokeWidth={2.1}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      );
    default:
      return null;
  }
}
