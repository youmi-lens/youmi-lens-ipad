/**
 * PK4-A — shared annotation tool identifiers.
 *
 * Notebook and Course Material each evolved their own product-level name for
 * the same conceptual tool (Notebook's `write` vs Course Material's `pen` —
 * see components/NotebookCanvas.tsx's `CanvasMode` and components/
 * MaterialFloatingToolbar.tsx's `MaterialToolMode`). This is the ONE shared,
 * normalized identifier set a future shared toolbar/command layer speaks in.
 *
 * This file introduces NO behavior change on its own: neither workspace's
 * internal mode type is touched here. Each workspace's adapter (Notebook's
 * is not yet wired — see the PK4-A report) translates between this shared
 * vocabulary and that workspace's existing internal value, so
 * `components/NotebookCanvas.tsx`'s `CanvasMode` keeps using `'write'`
 * internally, and `components/MaterialFloatingToolbar.tsx`'s
 * `MaterialToolMode` keeps using `'pen'` internally, unchanged.
 */

/** The complete set of conceptual annotation tools that exist ANYWHERE in
 * the app today — not every workspace supports every one (see
 * annotationCapabilities.ts). Nothing here is invented: every value maps to
 * a tool that genuinely exists in at least one workspace right now. */
export type AnnotationTool =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'scroll'
  | 'text'
  | 'select'
  | 'insert';

export const ANNOTATION_TOOLS: readonly AnnotationTool[] = [
  'pen',
  'highlighter',
  'eraser',
  'scroll',
  'text',
  'select',
  'insert',
] as const;

/**
 * Notebook's internal `CanvasMode` (components/NotebookCanvas.tsx) has two
 * values with no shared-tool counterpart today: `'in_progress'`-style modes
 * don't exist, but `CanvasMode` itself already only contains tool-shaped
 * values. This maps the shared vocabulary to Notebook's existing internal
 * names — pure data, reused by Notebook's future adapter (see the PK4-A
 * report's deferred Phase 6). Never used to rename anything inside
 * NotebookCanvas.tsx itself.
 */
export const SHARED_TOOL_TO_NOTEBOOK_MODE: Record<AnnotationTool, string> = {
  pen: 'write',
  highlighter: 'highlight',
  eraser: 'erase',
  scroll: 'scroll',
  text: 'type',
  select: 'select',
  insert: 'insert',
};

export const NOTEBOOK_MODE_TO_SHARED_TOOL: Record<string, AnnotationTool> = Object.fromEntries(
  Object.entries(SHARED_TOOL_TO_NOTEBOOK_MODE).map(([shared, notebook]) => [notebook, shared as AnnotationTool]),
);

/**
 * Course Material's internal `MaterialToolMode` matches the shared vocabulary
 * for its native tools. Select is native-PDF-only; Insert remains unavailable.
 * This identity mapping exists so callers never have to special-case "this
 * workspace's internal id already equals the shared id."
 */
export const SHARED_TOOL_TO_MATERIAL_MODE: Partial<Record<AnnotationTool, string>> = {
  pen: 'pen',
  highlighter: 'highlighter',
  eraser: 'eraser',
  scroll: 'scroll',
  text: 'text',
  select: 'select',
};

export const MATERIAL_MODE_TO_SHARED_TOOL: Record<string, AnnotationTool> = Object.fromEntries(
  Object.entries(SHARED_TOOL_TO_MATERIAL_MODE).map(([shared, material]) => [material as string, shared as AnnotationTool]),
);
