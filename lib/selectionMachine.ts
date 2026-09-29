/**
 * Shared SELECTION STATE MACHINE (Selection Interaction Phase). One authoritative model of
 * what is selected, used by Notebook (TS) and mirrored 1:1 by Course Material's native
 * overlay (Swift `SelectionMachine`, pinned by the same case table in
 * scripts/fixtures/selection-machine-cases.json).
 *
 * Selection changes ONLY through the explicit events below. Ambient things — a gesture
 * recogniser ending or being cancelled, a store echo, an annotation prop refresh, a Pencil lift, a
 * finger touching the selection, a rerender, a handle-drag completion — are `NOOP`
 * events and can never clear a selection.
 *
 * States: IDLE | SELECTING | SELECTED_INK | SELECTED_SHAPE | MOVING_SELECTION |
 *         SCALING_SELECTION | EDITING_SHAPE_HANDLE
 */
export type SelectionShapeKind = 'lasso' | 'rect';

export type SettledSelection =
  | { kind: 'SELECTED_INK'; ids: string[] }
  | { kind: 'SELECTED_SHAPE'; id: string };

export type SelectionState =
  | { kind: 'IDLE' }
  /** A new Box/Lasso region is being drawn. `previous` stays visible until the drag proves it is a region, and is restored if the gesture is cancelled. */
  | { kind: 'SELECTING'; shape: SelectionShapeKind; previous: SettledSelection | null }
  | SettledSelection
  | { kind: 'MOVING_SELECTION'; settled: SettledSelection }
  | { kind: 'SCALING_SELECTION'; settled: SettledSelection }
  | { kind: 'EDITING_SHAPE_HANDLE'; settled: { kind: 'SELECTED_SHAPE'; id: string } };

/** Every reason a selection may be cleared. Anything not listed here is NOT allowed to clear it. */
export const SELECTION_CLEAR_REASONS = [
  'blank-tap',
  'new-selection',
  'region-empty',
  'tool-change',
  'deleted',
  'page-change',
  'object-removed',
  'explicit-cancel',
] as const;
export type SelectionClearReason = (typeof SELECTION_CLEAR_REASONS)[number];

/** Ambient causes that must never change the selection. */
export const SELECTION_NOOP_CAUSES = [
  'gesture-ended',
  'gesture-cancelled',
  'recognizer-failed',
  'store-echo',
  'annotation-reload',
  'pencil-lift',
  'pencil-hover',
  'finger-touch-inside',
  'rerender',
  'handle-drag-complete',
  'undo-redo-object-exists',
] as const;
export type SelectionNoopCause = (typeof SELECTION_NOOP_CAUSES)[number];

export type SelectionEvent =
  | { type: 'BEGIN_REGION'; shape: SelectionShapeKind }
  | { type: 'REGION_DRAGGED' }
  | { type: 'REGION_COMPLETE'; ids: string[] }
  | { type: 'REGION_CANCELLED' }
  | { type: 'TAP_SHAPE'; id: string }
  | { type: 'TAP_BLANK' }
  | { type: 'SELECT_INK'; ids: string[] }
  | { type: 'BEGIN_MOVE' }
  | { type: 'END_MOVE' }
  | { type: 'BEGIN_SCALE' }
  | { type: 'END_SCALE' }
  | { type: 'BEGIN_HANDLE' }
  | { type: 'END_HANDLE' }
  | { type: 'MANIPULATION_CANCELLED' }
  | { type: 'TOOL_CHANGE'; tool: string }
  | { type: 'DELETE' }
  | { type: 'PAGE_CHANGE'; selectionStillValid: boolean }
  | { type: 'CONTENT_CHANGED'; existingIds: string[] }
  | { type: 'CANCEL' }
  | { type: 'NOOP'; cause: SelectionNoopCause };

export type SelectionResult = { state: SelectionState; cleared: SelectionClearReason | null };

export const IDLE_SELECTION: SelectionState = { kind: 'IDLE' };

export function settledOf(state: SelectionState): SettledSelection | null {
  switch (state.kind) {
    case 'SELECTED_INK':
    case 'SELECTED_SHAPE':
      return state;
    case 'MOVING_SELECTION':
    case 'SCALING_SELECTION':
    case 'EDITING_SHAPE_HANDLE':
      return state.settled;
    case 'SELECTING':
      return state.previous;
    default:
      return null;
  }
}

/** Ids that are selected (and drawn as selected) right now. */
export function selectedIdsOf(state: SelectionState): string[] {
  const settled = settledOf(state);
  if (!settled) return [];
  return settled.kind === 'SELECTED_INK' ? settled.ids : [settled.id];
}

export const isManipulating = (state: SelectionState): boolean =>
  state.kind === 'MOVING_SELECTION' || state.kind === 'SCALING_SELECTION' || state.kind === 'EDITING_SHAPE_HANDLE';

const same = (state: SelectionState): SelectionResult => ({ state, cleared: null });
const clear = (reason: SelectionClearReason, current: SelectionState): SelectionResult =>
  current.kind === 'IDLE' ? same(current) : { state: IDLE_SELECTION, cleared: reason };

/** Ink selection that came from a single tap-selected shape keeps shape semantics. */
export function selectionReduce(state: SelectionState, event: SelectionEvent): SelectionResult {
  const settled = settledOf(state);
  switch (event.type) {
    case 'NOOP':
      return same(state);

    case 'BEGIN_REGION':
      // The previous selection stays until the drag proves this is a region (see REGION_DRAGGED).
      return same({ kind: 'SELECTING', shape: event.shape, previous: settled });
    case 'REGION_DRAGGED':
      if (state.kind !== 'SELECTING' || !state.previous) return same(state);
      return { state: { ...state, previous: null }, cleared: 'new-selection' };
    case 'REGION_COMPLETE': {
      if (state.kind !== 'SELECTING') return same(state);
      if (event.ids.length === 0) return state.previous ? { state: IDLE_SELECTION, cleared: 'region-empty' } : same(IDLE_SELECTION);
      return same({ kind: 'SELECTED_INK', ids: [...event.ids] });
    }
    case 'REGION_CANCELLED':
      if (state.kind !== 'SELECTING') return same(state);
      return same(state.previous ?? IDLE_SELECTION);

    case 'TAP_SHAPE':
      return same({ kind: 'SELECTED_SHAPE', id: event.id });
    case 'TAP_BLANK':
      return clear('blank-tap', settled ? state : IDLE_SELECTION);
    case 'SELECT_INK':
      return event.ids.length === 0 ? clear('region-empty', state) : same({ kind: 'SELECTED_INK', ids: [...event.ids] });

    case 'BEGIN_MOVE':
      return settled && !isManipulating(state) ? same({ kind: 'MOVING_SELECTION', settled }) : same(state);
    case 'END_MOVE':
      return state.kind === 'MOVING_SELECTION' ? same(state.settled) : same(state);
    case 'BEGIN_SCALE':
      // A finger move upgrades to a scale when a second finger joins.
      return settled && state.kind !== 'EDITING_SHAPE_HANDLE' && state.kind !== 'SCALING_SELECTION'
        ? same({ kind: 'SCALING_SELECTION', settled })
        : same(state);
    case 'END_SCALE':
      return state.kind === 'SCALING_SELECTION' ? same(state.settled) : same(state);
    case 'BEGIN_HANDLE':
      return state.kind === 'SELECTED_SHAPE' ? same({ kind: 'EDITING_SHAPE_HANDLE', settled: state }) : same(state);
    case 'END_HANDLE':
      // A completed handle edit returns to SELECTED_SHAPE: same shape, handles still visible.
      return state.kind === 'EDITING_SHAPE_HANDLE' ? same(state.settled) : same(state);
    case 'MANIPULATION_CANCELLED':
      return isManipulating(state) ? same(settledOf(state) ?? IDLE_SELECTION) : same(state);

    case 'TOOL_CHANGE':
      return event.tool === 'select' ? same(state) : clear('tool-change', state);
    case 'DELETE':
      return clear('deleted', state);
    case 'PAGE_CHANGE':
      return event.selectionStillValid ? same(state) : clear('page-change', state);
    case 'CANCEL':
      return clear('explicit-cancel', state);

    case 'CONTENT_CHANGED': {
      // Undo/redo, store echo, reload: keep whatever still exists; drop only what is gone.
      if (!settled) return same(state);
      const existing = new Set(event.existingIds);
      if (settled.kind === 'SELECTED_SHAPE') return existing.has(settled.id) ? same(state) : clear('object-removed', state);
      const kept = settled.ids.filter((id) => existing.has(id));
      if (kept.length === 0) return clear('object-removed', state);
      if (kept.length === settled.ids.length) return same(state);
      const next: SettledSelection = { kind: 'SELECTED_INK', ids: kept };
      return same(state.kind === 'SELECTED_INK' ? next : rewrap(state, next));
    }
  }
}

function rewrap(state: SelectionState, settled: SettledSelection): SelectionState {
  switch (state.kind) {
    case 'MOVING_SELECTION': return { kind: 'MOVING_SELECTION', settled };
    case 'SCALING_SELECTION': return { kind: 'SCALING_SELECTION', settled };
    case 'SELECTING': return { ...state, previous: settled };
    default: return settled;
  }
}

/** Runs a whole event list (test / replay helper). */
export function runSelection(events: SelectionEvent[], start: SelectionState = IDLE_SELECTION): { state: SelectionState; cleared: (SelectionClearReason | null)[] } {
  let state = start;
  const cleared: (SelectionClearReason | null)[] = [];
  for (const event of events) {
    const result = selectionReduce(state, event);
    state = result.state;
    cleared.push(result.cleared);
  }
  return { state, cleared };
}
