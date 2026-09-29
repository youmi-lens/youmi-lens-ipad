/**
 * Test double for NotebookCanvas.dispatchSelection that runs the REAL shared state machine
 * (lib/selectionMachine.ts), so harnesses that execute production callbacks in isolation keep
 * exercising real selection semantics. The machine starts from the harness's current selection.
 */
import { selectedIdsOf, selectionReduce } from '../../lib/selectionMachine.ts';

export function makeDispatchSelection({ selectedIdsRef, setSelectedIds }) {
  let state = selectedIdsRef.current.size > 0
    ? { kind: 'SELECTED_INK', ids: [...selectedIdsRef.current] }
    : { kind: 'IDLE' };
  return (event) => {
    const result = selectionReduce(state, event);
    state = result.state;
    const ids = selectedIdsOf(state);
    const current = selectedIdsRef.current;
    if (ids.length !== current.size || ids.some((id) => !current.has(id))) {
      const next = new Set(ids);
      selectedIdsRef.current = next;
      setSelectedIds(next);
    }
    return result;
  };
}
