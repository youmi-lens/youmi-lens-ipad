import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reduceToolbarCollapsed,
  shouldStartToolbarTransition,
} from '../lib/notebookToolbarTransition.mjs';

assert.equal(shouldStartToolbarTransition(false, false), false);
assert.equal(shouldStartToolbarTransition(true, true), false);
assert.equal(shouldStartToolbarTransition(false, true), true);
assert.equal(shouldStartToolbarTransition(true, false), true);

let collapsed = false;
let starts = 0;
for (const requested of [true, false, true, false]) {
  if (shouldStartToolbarTransition(collapsed, requested)) starts += 1;
  collapsed = reduceToolbarCollapsed(collapsed, requested);
}
assert.equal(collapsed, false, 'rapid toggles end in the last requested state');
assert.equal(starts, 4, 'one transition starts per distinct toggle');
assert.equal(shouldStartToolbarTransition(collapsed, false), false, 'duplicate request is ignored');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'components/NotebookCanvas.tsx'), 'utf8');
assert.match(source, /const CompletedStrokeLayer = memo/);
assert.match(source, /export const NotebookCanvas = memo/);

// PK4-C1: the collapse/expand transition itself now lives in the one shared
// SharedAnnotationToolbar component that both Notebook and Course Material
// render — not duplicated back into NotebookCanvas.tsx.
const toolbarSource = fs.readFileSync(path.join(root, 'components/SharedAnnotationToolbar.tsx'), 'utf8');
assert.match(toolbarSource, /LayoutAnimation\.configureNext/);
assert.match(toolbarSource, /toolbarTransition\.stopAnimation\(\)/);
assert.match(toolbarSource, /useNativeDriver: true/);
assert.doesNotMatch(toolbarSource, /width:\s*toolbarTransition\.interpolate/);
assert.doesNotMatch(toolbarSource, /height:\s*toolbarTransition\.interpolate/);

console.log('Notebook toolbar transition tests passed.');
