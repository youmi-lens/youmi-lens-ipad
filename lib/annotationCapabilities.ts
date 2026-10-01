/**
 * PK4-A — shared annotation capability model.
 *
 * Drives which tools a future shared toolbar renders for a given workspace.
 * Capabilities are DERIVED from what each workspace actually supports today
 * — nothing here grants a workspace a tool it doesn't already have, and
 * nothing here is wired into either workspace's rendered UI yet (see the
 * PK4-A report).
 */
import type { AnnotationTool } from './annotationTools';

export type AnnotationCapabilities = {
  supportsPen: boolean;
  supportsHighlighter: boolean;
  supportsEraser: boolean;
  supportsScroll: boolean;
  supportsText: boolean;
  supportsSelection: boolean;
  supportsInsert: boolean;
  supportsUndoRedo: boolean;
};

/**
 * Notebook (components/NotebookCanvas.tsx's `PRIMARY_TOOLS` +
 * `showFixedHistory`): supports every tool in the shared vocabulary today.
 */
export const NOTEBOOK_CAPABILITIES: AnnotationCapabilities = {
  supportsPen: true,
  supportsHighlighter: true,
  supportsEraser: true,
  supportsScroll: true,
  supportsText: true,
  supportsSelection: true,
  supportsInsert: true,
  supportsUndoRedo: true,
};

/**
 * Course Material exposes native PDF selection on its PDFKit path. The
 * legacy JS overlay has no selection or text model. Image Insert remains
 * unavailable on both paths.
 *
 * Text support is conditional at runtime: app/lecture-material/[lectureId]/
 * [materialId].tsx only passes `showTextTool` on the native PDFKit path
 * (`useNativePdfViewer`); the legacy JS-overlay path has no text model at
 * all (its own comment: "'text' can never actually reach setAnnotationMode
 * at runtime"). `courseMaterialCapabilities(...)` below reflects that
 * instead of a single static constant, so a future shared toolbar consumer
 * can't accidentally show Text on the path that doesn't support it.
 */
export function courseMaterialCapabilities(options: { usingNativePdfViewer: boolean }): AnnotationCapabilities {
  return {
    supportsPen: true,
    supportsHighlighter: true,
    supportsEraser: true,
    supportsScroll: true,
    supportsText: options.usingNativePdfViewer,
    supportsSelection: options.usingNativePdfViewer,
    supportsInsert: false,
    supportsUndoRedo: true,
  };
}

/** Whether a capability set supports a given shared tool — the single
 * lookup a future shared toolbar uses to decide what to render. */
export function supportsTool(capabilities: AnnotationCapabilities, tool: AnnotationTool): boolean {
  switch (tool) {
    case 'pen': return capabilities.supportsPen;
    case 'highlighter': return capabilities.supportsHighlighter;
    case 'eraser': return capabilities.supportsEraser;
    case 'scroll': return capabilities.supportsScroll;
    case 'text': return capabilities.supportsText;
    case 'select': return capabilities.supportsSelection;
    case 'insert': return capabilities.supportsInsert;
    default: return false;
  }
}
