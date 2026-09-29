/**
 * Course Material unified Undo/Redo action log (P2, STAGE 2).
 *
 * ONE chronological history covering both strokes and text, so a mixed
 * sequence (draw → move text → draw → edit text) undoes in true recency
 * order instead of two independent per-type stacks silently interleaving
 * wrong. This is only an operation log ABOVE the existing stores — it does
 * not replace stroke or text storage. The material screen still owns
 * `MaterialAnnotationStroke[]` / `MaterialTextAnnotation[]` per page exactly
 * as before; this module only computes what the NEXT array should look like
 * given a recorded action and a direction (undo/redo), as a pure function.
 *
 * Scope: one history per open material/editing session. Each action carries
 * its page number, so scrolling does not discard earlier actions. The log
 * is not persisted across app restarts; annotations persist as before.
 */
import type { MaterialAnnotationStroke, MaterialTextAnnotation } from './models';

export type MaterialHistoryAction =
  | { kind: 'stroke-add'; pageNumber: number; stroke: MaterialAnnotationStroke }
  | {
      kind: 'stroke-erase';
      pageNumber: number;
      /** Full stroke array for the page immediately before the erase gesture. */
      before: MaterialAnnotationStroke[];
      /** Full stroke array for the page immediately after the erase gesture ended. */
      after: MaterialAnnotationStroke[];
    }
  | { kind: 'text-create'; pageNumber: number; annotation: MaterialTextAnnotation }
  | { kind: 'text-delete'; pageNumber: number; annotation: MaterialTextAnnotation }
  | { kind: 'text-edit'; pageNumber: number; annotationId: string; before: string; after: string }
  | {
      kind: 'page-clear';
      pageNumber: number;
      beforeStrokes: MaterialAnnotationStroke[];
      afterStrokes: MaterialAnnotationStroke[];
      beforeTextAnnotations: MaterialTextAnnotation[];
      afterTextAnnotations: MaterialTextAnnotation[];
    }
  | {
      kind: 'selection-change';
      pageNumber: number;
      beforeStrokes: MaterialAnnotationStroke[];
      afterStrokes: MaterialAnnotationStroke[];
    }
  | {
      /** One completed drag of selected ink: exact geometry before and after. */
      kind: 'selection-move';
      pageNumber: number;
      strokeIds: string[];
      beforeStrokes: MaterialAnnotationStroke[];
      afterStrokes: MaterialAnnotationStroke[];
    }
  | {
      /** One completed two-finger pinch of selected ink: exact geometry before and after. */
      kind: 'selection-scale';
      pageNumber: number;
      strokeIds: string[];
      beforeStrokes: MaterialAnnotationStroke[];
      afterStrokes: MaterialAnnotationStroke[];
    }
  | {
      /**
       * One completed drag whose release landed on ANOTHER PDF page: the selected group changes page bucket.
       * Encodes BOTH pages' exact arrays before and after, so Undo/Redo restore geometry AND page ownership.
       */
      kind: 'selection-transfer';
      /** Source page. */
      pageNumber: number;
      toPageNumber: number;
      strokeIds: string[];
      beforeStrokes: MaterialAnnotationStroke[];
      afterStrokes: MaterialAnnotationStroke[];
      beforeToStrokes: MaterialAnnotationStroke[];
      afterToStrokes: MaterialAnnotationStroke[];
    }
  | {
      /** One completed structured-shape handle drag: exact geometry before and after. */
      kind: 'shape-edit';
      pageNumber: number;
      strokeId: string;
      beforeStrokes: MaterialAnnotationStroke[];
      afterStrokes: MaterialAnnotationStroke[];
    }
  | {
      kind: 'text-move';
      pageNumber: number;
      annotationId: string;
      before: { x: number; y: number };
      after: { x: number; y: number };
    };

export type MaterialHistoryState = {
  undo: MaterialHistoryAction[];
  redo: MaterialHistoryAction[];
};

export const EMPTY_MATERIAL_HISTORY: MaterialHistoryState = { undo: [], redo: [] };

/** Every completed user action pushes exactly one entry and clears redo. */
export function pushMaterialHistory(
  state: MaterialHistoryState,
  action: MaterialHistoryAction,
): MaterialHistoryState {
  return { undo: [...state.undo, action], redo: [] };
}

export type MaterialHistoryPop = { action: MaterialHistoryAction; state: MaterialHistoryState };

/** Moves the most recent undo entry to redo. Null when nothing to undo. */
export function popMaterialHistoryUndo(state: MaterialHistoryState): MaterialHistoryPop | null {
  if (state.undo.length === 0) return null;
  const action = state.undo[state.undo.length - 1];
  return { action, state: { undo: state.undo.slice(0, -1), redo: [...state.redo, action] } };
}

/** Moves the most recent redo entry back to undo. Null when nothing to redo. */
export function popMaterialHistoryRedo(state: MaterialHistoryState): MaterialHistoryPop | null {
  if (state.redo.length === 0) return null;
  const action = state.redo[state.redo.length - 1];
  return { action, state: { undo: [...state.undo, action], redo: state.redo.slice(0, -1) } };
}

export type MaterialHistoryApplyResult = {
  strokes: MaterialAnnotationStroke[];
  textAnnotations: MaterialTextAnnotation[];
  /**
   * Stroke ids that just disappeared from `strokes` as a direct result of
   * this step (undo of a stroke-add, or redo of an erase/page-clear). The caller
   * must notify the native view's markStrokeRemovalIntent with these BEFORE
   * committing the new annotationsByPage snapshot — see
   * AnnotationOverlay.markStrokeRemovalIntent's doc comment for why: without
   * it, the native stale-snapshot guard (pendingLocalStrokeIds) can silently
   * re-draw a stroke this step just removed. Adds (undo of an erase, redo of
   * an add) are never subject to that guard, so this is empty for those.
   */
  removedStrokeIds: string[];
  /** Full stroke arrays for OTHER pages this step also changes (a cross-page transfer touches two pages). */
  otherPages?: { pageNumber: number; strokes: MaterialAnnotationStroke[] }[];
  /** Where the selection lives after this step (a transfer's Undo/Redo re-selects the group on its page). */
  selection?: { pageNumber: number; strokeIds: string[] };
};

/** Reverses `action`, given the CURRENT strokes/text for its page. */
export function applyMaterialHistoryUndo(
  action: MaterialHistoryAction,
  strokes: MaterialAnnotationStroke[],
  textAnnotations: MaterialTextAnnotation[],
): MaterialHistoryApplyResult {
  switch (action.kind) {
    case 'stroke-add':
      return {
        strokes: strokes.filter((s) => s.id !== action.stroke.id),
        textAnnotations,
        removedStrokeIds: [action.stroke.id],
      };
    case 'stroke-erase':
      return { strokes: action.before, textAnnotations, removedStrokeIds: [] };
    case 'page-clear':
      return {
        strokes: action.beforeStrokes,
        textAnnotations: action.beforeTextAnnotations,
        removedStrokeIds: [],
      };
    case 'selection-move':
    case 'selection-scale':
    case 'shape-edit':
      return { strokes: action.beforeStrokes, textAnnotations, removedStrokeIds: [] };
    case 'selection-transfer':
      return {
        strokes: action.beforeStrokes,
        textAnnotations,
        removedStrokeIds: [],
        otherPages: [{ pageNumber: action.toPageNumber, strokes: action.beforeToStrokes }],
        selection: { pageNumber: action.pageNumber, strokeIds: action.strokeIds },
      };
    case 'selection-change': {
      const beforeIds = new Set(action.beforeStrokes.map((stroke) => stroke.id));
      return {
        strokes: action.beforeStrokes,
        textAnnotations,
        removedStrokeIds: action.afterStrokes.filter((stroke) => !beforeIds.has(stroke.id)).map((stroke) => stroke.id),
      };
    }
    case 'text-create':
      return {
        strokes,
        textAnnotations: textAnnotations.filter((a) => a.id !== action.annotation.id),
        removedStrokeIds: [],
      };
    case 'text-delete':
      return { strokes, textAnnotations: [...textAnnotations, action.annotation], removedStrokeIds: [] };
    case 'text-edit':
      return {
        strokes,
        textAnnotations: textAnnotations.map((a) =>
          a.id === action.annotationId ? { ...a, text: action.before } : a,
        ),
        removedStrokeIds: [],
      };
    case 'text-move':
      return {
        strokes,
        textAnnotations: textAnnotations.map((a) =>
          a.id === action.annotationId ? { ...a, x: action.before.x, y: action.before.y } : a,
        ),
        removedStrokeIds: [],
      };
  }
}

/** Re-applies `action`, given the CURRENT strokes/text for its page. */
export function applyMaterialHistoryRedo(
  action: MaterialHistoryAction,
  strokes: MaterialAnnotationStroke[],
  textAnnotations: MaterialTextAnnotation[],
): MaterialHistoryApplyResult {
  switch (action.kind) {
    case 'stroke-add':
      return { strokes: [...strokes, action.stroke], textAnnotations, removedStrokeIds: [] };
    case 'stroke-erase': {
      const afterIds = new Set(action.after.map((s) => s.id));
      const removedStrokeIds = action.before.filter((s) => !afterIds.has(s.id)).map((s) => s.id);
      return { strokes: action.after, textAnnotations, removedStrokeIds };
    }
    case 'page-clear': {
      const afterIds = new Set(action.afterStrokes.map((stroke) => stroke.id));
      return {
        strokes: action.afterStrokes,
        textAnnotations: action.afterTextAnnotations,
        removedStrokeIds: action.beforeStrokes.filter((stroke) => !afterIds.has(stroke.id)).map((stroke) => stroke.id),
      };
    }
    case 'selection-move':
    case 'selection-scale':
    case 'shape-edit':
      return { strokes: action.afterStrokes, textAnnotations, removedStrokeIds: [] };
    case 'selection-transfer':
      return {
        strokes: action.afterStrokes,
        textAnnotations,
        removedStrokeIds: [],
        otherPages: [{ pageNumber: action.toPageNumber, strokes: action.afterToStrokes }],
        selection: { pageNumber: action.toPageNumber, strokeIds: action.strokeIds },
      };
    case 'selection-change': {
      const afterIds = new Set(action.afterStrokes.map((stroke) => stroke.id));
      return {
        strokes: action.afterStrokes,
        textAnnotations,
        removedStrokeIds: action.beforeStrokes.filter((stroke) => !afterIds.has(stroke.id)).map((stroke) => stroke.id),
      };
    }
    case 'text-create':
      return { strokes, textAnnotations: [...textAnnotations, action.annotation], removedStrokeIds: [] };
    case 'text-delete':
      return {
        strokes,
        textAnnotations: textAnnotations.filter((a) => a.id !== action.annotation.id),
        removedStrokeIds: [],
      };
    case 'text-edit':
      return {
        strokes,
        textAnnotations: textAnnotations.map((a) =>
          a.id === action.annotationId ? { ...a, text: action.after } : a,
        ),
        removedStrokeIds: [],
      };
    case 'text-move':
      return {
        strokes,
        textAnnotations: textAnnotations.map((a) =>
          a.id === action.annotationId ? { ...a, x: action.after.x, y: action.after.y } : a,
        ),
        removedStrokeIds: [],
      };
  }
}
