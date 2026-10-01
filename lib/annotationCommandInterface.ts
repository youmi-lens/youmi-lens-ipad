/**
 * PK4-A — shared annotation presentation-level command interface.
 *
 * This is an INTERFACE only — no runtime logic, no state, no history. A
 * future shared toolbar component is written once against this shape;
 * Notebook and Course Material each implement it by wrapping their OWN
 * existing, unmerged internals (Notebook's local history/mode state,
 * Course Material's native/legacy history + PDF annotation mode state).
 *
 * Explicitly NOT merged by this interface: Notebook's undo/redo stack,
 * Course Material's native unified history, and the legacy JS-overlay's
 * separate stroke-only redo stack all remain exactly as they are. `canUndo`/
 * `canRedo`/`undo`/`redo` here are a CONTRACT a workspace adapter fulfills
 * from its own state — never a second, competing history implementation.
 */
import type { AnnotationTool } from './annotationTools';
import type { EraserPreset, HighlighterPreset, PenPreset } from './annotationPresets';
import type { AnnotationCapabilities } from './annotationCapabilities';

export type AnnotationCommandInterface = {
  capabilities: AnnotationCapabilities;

  selectedTool: AnnotationTool;
  setTool: (tool: AnnotationTool) => void;

  selectedPenPreset: PenPreset;
  setPenPreset: (preset: PenPreset) => void;
  selectedHighlighterPreset: HighlighterPreset;
  setHighlighterPreset: (preset: HighlighterPreset) => void;
  selectedEraserPreset: EraserPreset;
  setEraserPreset: (preset: EraserPreset) => void;

  /** Hex/rgba string, meaning defined by the active tool (pen vs highlighter
   * color) — matches how both existing toolbars already pass a single
   * `color`/`onSelectColor` pair keyed off the current mode. */
  selectedColor: string;
  setColor: (color: string) => void;

  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
};
