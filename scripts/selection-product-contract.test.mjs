import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  appendFreeform, boxFromCorners, pointInSelection, selectedInkIds,
  selectionAcceptsPointer, startFreeform,
} from '../lib/selectionSemantics.ts';

const notebook = readFileSync(new URL('../components/NotebookCanvas.tsx', import.meta.url), 'utf8');
const native = readFileSync(new URL('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../app/lecture-material/[lectureId]/[materialId].tsx', import.meta.url), 'utf8');

assert.equal(selectionAcceptsPointer('touch'), false);
assert.equal(selectionAcceptsPointer('stylus'), true);
// Selection CREATION stays Pencil-only; a finger may only MANIPULATE an existing selection (routeSelectionTouch).
assert.match(notebook, /else if \(!selectionAcceptsPointer\(isStylusTouch \? 'stylus' : 'touch'\)\)/);
assert.match(notebook, /routeSelectionTouch\(\{\s*pointer: 'touch',\s*touchCount: 1,/);
assert.match(notebook, /if \(route !== 'selection-move' && route !== 'shape-handle-edit'\) \{\s*manager\.fail\(\);/, 'a finger outside the selection (and not on a handle) fails so the page navigates');
assert.match(native, /selectionGesture: PageSelectionGestureRecognizer[\s\S]*?allowedTouchTypes = \[NSNumber\(value: UITouch\.TouchType\.pencil\.rawValue\)\]/);
assert.match(native, /let touch = touches\.first, touch\.type == \.pencil/);
assert.match(native, /let isAnnotationTool = isInkTool \|\| annotationMode == "select"/);
assert.match(screen, /showFixedHistory/);

const a = { x: 10, y: 20 };
const first = startFreeform(a);
assert.deepEqual(first, [a]);
const lasso = appendFreeform(appendFreeform(appendFreeform(first, { x: 50, y: 20 }), { x: 50, y: 60 }), { x: 10, y: 60 });
assert.deepEqual(lasso, [a, { x: 50, y: 20 }, { x: 50, y: 60 }, { x: 10, y: 60 }]);
assert.equal(pointInSelection({ x: 30, y: 40 }, 'lasso', lasso), true, 'last-to-first closes logically');
assert.equal(pointInSelection({ x: 65, y: 40 }, 'lasso', lasso), false);
assert.equal(pointInSelection({ x: 30, y: 40 }, 'lasso', first), false);
assert.match(notebook, /join\(' L '\)}`}/);
assert.doesNotMatch(native.slice(native.indexOf('private func drawSelectionChrome()'), native.indexOf('func refreshSelectionChrome()')), /path\.close\(\)/);

assert.deepEqual(boxFromCorners(a, a), { x: 10, y: 20, width: 0, height: 0 });
assert.deepEqual(boxFromCorners({ x: 50, y: 60 }, a), { x: 10, y: 20, width: 40, height: 40 });
assert.deepEqual(boxFromCorners(a, { x: 90, y: 35 }), { x: 10, y: 20, width: 80, height: 15 });
assert.deepEqual(boxFromCorners(a, { x: 25, y: 100 }), { x: 10, y: 20, width: 15, height: 80 });
assert.equal(pointInSelection({ x: 30, y: 40 }, 'rect', [a, { x: 50, y: 60 }]), true);

const ink = [{ id: 'CA', points: [{ x: 25, y: 35 }, { x: 35, y: 40 }] }, { id: 'outside', points: [{ x: 80, y: 80 }] }];
assert.deepEqual([...selectedInkIds(ink, 'lasso', lasso)], ['CA']);
assert.deepEqual([...selectedInkIds(ink, 'rect', [a, { x: 50, y: 60 }])], ['CA']);
assert.match(native, /return \(number, ids\.sorted\(\)\)/);
assert.doesNotMatch(native, /selectedTextIds/);
console.log('selection-product-contract: Pencil routing, open freeform, box, ink-only, history chrome PASS');
