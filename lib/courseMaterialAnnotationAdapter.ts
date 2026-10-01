/**
 * PK4-C — Course Material's boundary to the shared annotation tool system.
 *
 * Mirrors lib/notebookAnnotationAdapter.ts exactly: the smallest possible
 * adapter, translating between Course Material's own `MaterialToolMode` and
 * the shared `AnnotationTool` vocabulary using PK4-A's own translation
 * tables (`SHARED_TOOL_TO_MATERIAL_MODE`/`MATERIAL_MODE_TO_SHARED_TOOL` —
 * never a second, competing mapping), and deriving which shared tools
 * Course Material exposes from the shared capability model
 * (`courseMaterialCapabilities`) rather than a separately hardcoded list.
 *
 * Never references PDF rendering, PDF persistence, PDF export, or either
 * annotation overlay's (native PDFKit / legacy JS) internal state.
 */
import { courseMaterialCapabilities, supportsTool, type AnnotationCapabilities } from './annotationCapabilities';
import { MATERIAL_MODE_TO_SHARED_TOOL, SHARED_TOOL_TO_MATERIAL_MODE, type AnnotationTool } from './annotationTools';

/**
 * Course Material's own internal tool-mode union. Previously defined in
 * components/MaterialFloatingToolbar.tsx (retired by PK4-C1, which promoted
 * Course Material onto the single shared SharedAnnotationToolbar component);
 * this union lives with the adapter that is its only remaining consumer.
 */
export type MaterialToolMode = 'scroll' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'select';

/**
 * Course Material's tool row, in display order. Same hand-authored-order
 * caveat as Notebook's adapter: order is a product decision, not something
 * the shared vocabulary encodes. Replaces the previously hardcoded
 * `PRIMARY_DRAW_TOOLS`/`TEXT_TOOL` in MaterialFloatingToolbar.tsx. The
 * supported tools follow Notebook's master order: Pen, Highlighter, Text,
 * Select, Eraser. Native PDFKit exposes Text and Select; legacy filters both.
 */
const MATERIAL_TOOL_ORDER: readonly AnnotationTool[] = ['pen', 'highlighter', 'text', 'select', 'eraser'];

/** Display labels — same strings the old hardcoded arrays used ('Pen',
 * 'Highlight', 'Eraser', 'Text'). */
const MATERIAL_TOOL_LABELS: Partial<Record<AnnotationTool, string>> = {
  pen: 'Pen',
  highlighter: 'Highlight',
  eraser: 'Eraser',
  text: 'Text',
  select: 'Select',
};

/** Capability-filtered, ordered shared tool ids Course Material renders.
 * Native PDFKit includes Text and Select; legacy filters both. */
export function courseMaterialSharedTools(capabilities: AnnotationCapabilities): AnnotationTool[] {
  return MATERIAL_TOOL_ORDER.filter((tool) => supportsTool(capabilities, tool));
}

export function courseMaterialToolLabel(tool: AnnotationTool): string {
  return MATERIAL_TOOL_LABELS[tool] ?? tool;
}

/** Course Material internal mode -> shared tool id. */
export function materialModeToSharedTool(mode: MaterialToolMode): AnnotationTool | null {
  return MATERIAL_MODE_TO_SHARED_TOOL[mode] ?? null;
}

/** Shared tool id -> Course Material's internal mode, for wiring a shared
 * toolbar's `onSelectTool`/`keyFor` back into Course Material's existing
 * `onChangeMode` handlers. */
export function sharedToolToMaterialMode(tool: AnnotationTool): MaterialToolMode {
  return SHARED_TOOL_TO_MATERIAL_MODE[tool] as MaterialToolMode;
}

export { courseMaterialCapabilities };
