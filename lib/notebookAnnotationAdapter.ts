/**
 * PK4-B1 — Notebook's boundary to the shared annotation tool system.
 *
 * The smallest possible adapter: translates between Notebook's own internal
 * `CanvasMode` and the shared `AnnotationTool` vocabulary using PK4-A's own
 * translation tables (`SHARED_TOOL_TO_NOTEBOOK_MODE`/
 * `NOTEBOOK_MODE_TO_SHARED_TOOL` — never a second, competing mapping), and
 * derives which shared tools Notebook currently exposes from the shared
 * capability model (`NOTEBOOK_CAPABILITIES`) rather than a separately
 * hardcoded tool list. Notebook's document/history/persistence internals
 * (NoteStroke, PKDrawing, undo/redo stacks) are never referenced here.
 */
import type { CanvasMode } from '@/components/NotebookCanvas';
import { NOTEBOOK_CAPABILITIES, supportsTool } from './annotationCapabilities';
import { NOTEBOOK_MODE_TO_SHARED_TOOL, SHARED_TOOL_TO_NOTEBOOK_MODE, type AnnotationTool } from './annotationTools';

/**
 * Notebook's primary tool row, in display order — this list itself is the
 * one piece that has to stay hand-authored (display order is a product
 * decision, not something the shared vocabulary encodes), but every tool in
 * it is then filtered through the shared capability model below rather than
 * assumed supported. This replaces the previously hardcoded
 * `PRIMARY_TOOLS`/`DRAW_MODES` array in NotebookCanvas.tsx — same 6 tools,
 * same order (pen, highlighter, text, select, insert, eraser), sourced from
 * the shared vocabulary instead of independently re-declared.
 */
const NOTEBOOK_TOOL_ORDER: readonly AnnotationTool[] = ['pen', 'highlighter', 'text', 'select', 'insert', 'eraser'];

/** Display labels, keyed by shared tool id — same strings Notebook's old
 * hardcoded `PRIMARY_TOOLS` used ('Write', 'Highlight', 'Text', 'Select',
 * 'Insert', 'Erase'), just keyed by the shared id instead of by CanvasMode. */
const NOTEBOOK_TOOL_LABELS: Record<AnnotationTool, string> = {
  pen: 'Write',
  highlighter: 'Highlight',
  eraser: 'Erase',
  scroll: 'Scroll',
  text: 'Text',
  select: 'Select',
  insert: 'Insert',
};

/** Capability-filtered, ordered shared tool ids Notebook renders today.
 * With `NOTEBOOK_CAPABILITIES` (every tool `true`), this is currently a
 * no-op filter — the mechanism is what matters: adding a tool here without
 * marking it supported in annotationCapabilities.ts would silently drop it,
 * rather than requiring a second place to keep in sync. */
export function notebookSharedTools(): AnnotationTool[] {
  return NOTEBOOK_TOOL_ORDER.filter((tool) => supportsTool(NOTEBOOK_CAPABILITIES, tool));
}

export function notebookToolLabel(tool: AnnotationTool): string {
  return NOTEBOOK_TOOL_LABELS[tool];
}

/** Notebook internal mode -> shared tool id. Returns null for a Notebook
 * mode that has no shared-tool counterpart (there are none today — every
 * `CanvasMode` value has an entry in `NOTEBOOK_MODE_TO_SHARED_TOOL`). */
export function notebookModeToSharedTool(mode: CanvasMode): AnnotationTool | null {
  return NOTEBOOK_MODE_TO_SHARED_TOOL[mode] ?? null;
}

/** Shared tool id -> Notebook's internal mode, for wiring a shared toolbar's
 * `onSelectTool` callback back into Notebook's existing `changeMode`. */
export function sharedToolToNotebookMode(tool: AnnotationTool): CanvasMode {
  return SHARED_TOOL_TO_NOTEBOOK_MODE[tool] as CanvasMode;
}
