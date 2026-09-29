/**
 * Shared selection state machine: transitions, EVERY clear-selection path, and every ambient
 * cause that must NOT clear. The same case table (scripts/fixtures/selection-machine-cases.json)
 * is replayed by the native Swift SelectionMachine in material_selection_fixture.swift.
 * Run: node --experimental-strip-types scripts/selection-machine.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  IDLE_SELECTION, SELECTION_CLEAR_REASONS, SELECTION_NOOP_CAUSES,
  isManipulating, runSelection, selectedIdsOf, selectionReduce,
} from '../lib/selectionMachine.ts';

const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const cases = JSON.parse(readFileSync(new URL('./fixtures/selection-machine-cases.json', import.meta.url), 'utf8'));

/** Case-table event encoding shared with the Swift fixture. */
function decode([name, ...args]) {
  switch (name) {
    case 'REGION_BEGIN_LASSO': return { type: 'BEGIN_REGION', shape: 'lasso' };
    case 'REGION_COMPLETE': return { type: 'REGION_COMPLETE', ids: args };
    case 'SELECT_INK': return { type: 'SELECT_INK', ids: args };
    case 'TAP_SHAPE': return { type: 'TAP_SHAPE', id: args[0] };
    case 'TOOL_CHANGE': return { type: 'TOOL_CHANGE', tool: args[0] };
    case 'PAGE_CHANGE': return { type: 'PAGE_CHANGE', selectionStillValid: args[0] === 'valid' };
    case 'CONTENT_CHANGED': return { type: 'CONTENT_CHANGED', existingIds: args };
    case 'NOOP': return { type: 'NOOP', cause: args[0] };
    default: return { type: name };
  }
}

console.log('Case table (shared with native)');
for (const c of cases) {
  check(c.name, () => {
    const { state, cleared } = runSelection(c.events.map(decode));
    assert.equal(state.kind, c.kind);
    assert.deepEqual(selectedIdsOf(state), c.ids);
    assert.deepEqual(cleared, c.cleared);
  });
}

console.log('\nEvery ambient cause is a no-op in every selected/manipulating state');
check('NOOP causes never change any state (shape, ink, moving, scaling, editing, selecting)', () => {
  const states = [
    runSelection([{ type: 'TAP_SHAPE', id: 's' }]).state,
    runSelection([{ type: 'SELECT_INK', ids: ['a', 'b'] }]).state,
    runSelection([{ type: 'SELECT_INK', ids: ['a'] }, { type: 'BEGIN_MOVE' }]).state,
    runSelection([{ type: 'SELECT_INK', ids: ['a'] }, { type: 'BEGIN_SCALE' }]).state,
    runSelection([{ type: 'TAP_SHAPE', id: 's' }, { type: 'BEGIN_HANDLE' }]).state,
    runSelection([{ type: 'SELECT_INK', ids: ['a'] }, { type: 'BEGIN_REGION', shape: 'rect' }]).state,
  ];
  for (const state of states) for (const cause of SELECTION_NOOP_CAUSES) {
    const result = selectionReduce(state, { type: 'NOOP', cause });
    assert.equal(result.state, state, `${state.kind} + ${cause}`);
    assert.equal(result.cleared, null);
  }
});

console.log('\nThe complete list of clear paths (nothing else may clear)');
check('each documented reason is reachable, and only through its explicit event', () => {
  const reached = new Set();
  const fromShape = () => runSelection([{ type: 'TAP_SHAPE', id: 's' }]).state;
  const fromInk = () => runSelection([{ type: 'SELECT_INK', ids: ['a'] }]).state;
  const probes = [
    [fromShape(), { type: 'TAP_BLANK' }, 'blank-tap'],
    [runSelection([{ type: 'SELECT_INK', ids: ['a'] }, { type: 'BEGIN_REGION', shape: 'lasso' }]).state, { type: 'REGION_DRAGGED' }, 'new-selection'],
    [runSelection([{ type: 'SELECT_INK', ids: ['a'] }, { type: 'BEGIN_REGION', shape: 'lasso' }]).state, { type: 'REGION_COMPLETE', ids: [] }, 'region-empty'],
    [fromShape(), { type: 'TOOL_CHANGE', tool: 'eraser' }, 'tool-change'],
    [fromInk(), { type: 'DELETE' }, 'deleted'],
    [fromInk(), { type: 'PAGE_CHANGE', selectionStillValid: false }, 'page-change'],
    [fromShape(), { type: 'CONTENT_CHANGED', existingIds: [] }, 'object-removed'],
    [fromInk(), { type: 'CANCEL' }, 'explicit-cancel'],
  ];
  for (const [state, event, reason] of probes) {
    const result = selectionReduce(state, event);
    assert.equal(result.cleared, reason);
    assert.equal(result.state.kind === 'IDLE' || result.state.kind === 'SELECTING', true);
    reached.add(reason);
  }
  assert.deepEqual([...reached].sort(), [...SELECTION_CLEAR_REASONS].sort(), 'every reason exercised');
});
check('manipulation begin/end pairs always land on the SAME selection (never IDLE)', () => {
  for (const [begin, end] of [['BEGIN_MOVE', 'END_MOVE'], ['BEGIN_SCALE', 'END_SCALE']]) {
    const before = runSelection([{ type: 'SELECT_INK', ids: ['a', 'b'] }]).state;
    const during = selectionReduce(before, { type: begin }).state;
    assert.ok(isManipulating(during));
    assert.deepEqual(selectedIdsOf(during), ['a', 'b'], 'selection stays visible while manipulating');
    assert.deepEqual(selectionReduce(during, { type: end }).state, before);
  }
  const shape = runSelection([{ type: 'TAP_SHAPE', id: 's' }]).state;
  const editing = selectionReduce(shape, { type: 'BEGIN_HANDLE' }).state;
  assert.deepEqual(selectedIdsOf(editing), ['s']);
  assert.deepEqual(selectionReduce(editing, { type: 'END_HANDLE' }).state, shape);
});
check('a move upgrades to a scale when a second finger joins and still ends selected', () => {
  const { state } = runSelection([{ type: 'SELECT_INK', ids: ['a'] }, { type: 'BEGIN_MOVE' }, { type: 'BEGIN_SCALE' }, { type: 'END_SCALE' }]);
  assert.deepEqual(state, { kind: 'SELECTED_INK', ids: ['a'] });
});
check('IDLE is only ever reached through a clear reason', () => {
  const idle = runSelection([]).state;
  assert.deepEqual(idle, IDLE_SELECTION);
  for (const c of cases) {
    const { state, cleared } = runSelection(c.events.map(decode));
    if (state.kind === 'IDLE' && c.events.length > 0 && c.events.some((e) => e[0] !== 'TAP_BLANK' || true)) {
      const reasons = cleared.filter(Boolean);
      const startedIdle = !c.events.some((e) => ['TAP_SHAPE', 'SELECT_INK'].includes(e[0]));
      assert.ok(reasons.length > 0 || startedIdle, `${c.name}: became IDLE without a reason`);
    }
  }
});
console.log('\nselection-machine: all checks passed');
