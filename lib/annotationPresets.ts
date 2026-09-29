/**
 * PK4-A — shared semantic annotation presets.
 *
 * The shared product truth is the semantic tier (THIN/MEDIUM/THICK, etc.),
 * never a raw number. Each renderer maps a tier to ITS OWN physically/
 * product-accepted numeric value below — verified directly against the
 * current source of each, not assumed. Where two renderers' accepted
 * numbers are already proven identical, they share one numeric table;
 * where they differ, they keep separate tables. No numeric value here was
 * changed from what each renderer already uses today.
 */

export type PenPreset = 'thin' | 'medium' | 'thick';
export type HighlighterPreset = 'narrow' | 'medium' | 'wide';
export type EraserPreset = 'small' | 'medium' | 'large';

export const PEN_PRESETS: readonly PenPreset[] = ['thin', 'medium', 'thick'] as const;
export const HIGHLIGHTER_PRESETS: readonly HighlighterPreset[] = ['narrow', 'medium', 'wide'] as const;
export const ERASER_PRESETS: readonly EraserPreset[] = ['small', 'medium', 'large'] as const;

/**
 * Pen width, points. Verified identical between Notebook's LEGACY (SVG
 * NoteStroke) renderer (components/NotebookCanvas.tsx's `PEN_WIDTHS`: Thin
 * 2 / Medium 3.5 / Thick 6) and Course Material's custom renderer
 * (app/lecture-material/[lectureId]/[materialId].tsx's `PEN_WIDTHS`, whose
 * own comment records these were deliberately corrected to match Notebook's
 * exactly after a real product bug — Course Material's pen felt "like a
 * heavier marker" while ~15-20% thicker at every tier). Shared here because
 * they are proven, intentionally-identical values, not merely similar ones.
 */
export const LEGACY_STYLE_PEN_WIDTHS: Record<PenPreset, number> = {
  thin: 2,
  medium: 3.5,
  thick: 6,
};

/**
 * Pen width, points, for Notebook's PencilKit renderer only (modules/
 * expo-pencilkit-test/ios/PencilKitTestModule.swift's `widthPresets`).
 * Physically accepted (PK2) against PencilKit's own real device-queried
 * `validWidthRange` — DELIBERATELY different from the legacy set above
 * (PencilKit's textured `.pen` ink renders differently at a given numeric
 * width than a plain SVG/CGContext stroke). FROZEN — do not retune, and do
 * not unify with LEGACY_STYLE_PEN_WIDTHS.
 */
export const PENCILKIT_PEN_WIDTHS: Record<PenPreset, number> = {
  thin: 1.5,
  medium: 2.68,
  thick: 6.0,
};

/**
 * Highlighter width, points. Verified identical between Notebook's
 * `HIGHLIGHTER_WIDTHS` (Narrow 12 / Medium 18 / Wide 26) and Course
 * Material's own `HIGHLIGHTER_WIDTHS` (same three values). Both workspaces'
 * highlighter is the same non-PencilKit rendering family, so one shared
 * table is accurate today.
 */
export const HIGHLIGHTER_WIDTHS: Record<HighlighterPreset, number> = {
  narrow: 12,
  medium: 18,
  wide: 26,
};

/**
 * Eraser radius, points, Notebook only (components/NotebookCanvas.tsx's
 * `ERASER_SIZES`: small 12 / medium 26 / large 44).
 *
 * NOT identical to Course Material's own eraser radii (app/lecture-material/
 * [lectureId]/[materialId].tsx's `ERASER_SIZES`: small 16 / medium 26 /
 * large 40) — verified directly; only "medium" happens to coincide. Kept as
 * two separate tables rather than forced into one, per the explicit
 * instruction not to modify any accepted numeric value.
 */
export const NOTEBOOK_ERASER_RADII: Record<EraserPreset, number> = {
  small: 12,
  medium: 26,
  large: 44,
};

/** Eraser radius, points, Course Material only — see NOTEBOOK_ERASER_RADII's
 * doc comment for why this is a separate table, not a shared one. */
export const COURSE_MATERIAL_ERASER_RADII: Record<EraserPreset, number> = {
  small: 16,
  medium: 26,
  large: 40,
};

/**
 * Pen/highlighter colors are NOT shared in this phase: verified directly,
 * Notebook's PEN_COLORS (7 colors) and Course Material's PEN_COLORS (5
 * colors, different hex values even for same-named colors like "Blue" and
 * "Red") are genuinely different today, as are the two HIGHLIGHTER_COLORS
 * lists. Forcing them into one shared list would be a real, unintended
 * visual/behavior change, which this phase must not introduce. Each
 * workspace keeps its own existing color list unchanged.
 */
