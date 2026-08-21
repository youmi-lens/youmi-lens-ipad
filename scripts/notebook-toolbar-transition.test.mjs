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
assert.match(source, /LayoutAnimation\.configureNext/);
assert.match(source, /toolbarTransition\.stopAnimation\(\)/);
assert.match(source, /useNativeDriver: true/);
assert.doesNotMatch(source, /width:\s*toolbarTransition\.interpolate/);
assert.doesNotMatch(source, /height:\s*toolbarTransition\.interpolate/);
assert.match(source, /const CompletedStrokeLayer = memo/);
assert.match(source, /export const NotebookCanvas = memo/);

console.log('Notebook toolbar transition tests passed.');
