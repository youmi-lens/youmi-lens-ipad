/**
 * PK4-C3 — (1) the Pencil-write gate that keeps the heavy `annotationsByPage`
 * prop delivery (a 72-84 ms main-thread stall in the device log) out of active
 * strokes, and (2) the selection-outline contract after a drag.
 * Run: node --experimental-strip-types scripts/material-ink-prop-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  INK_PROP_GATE_IDLE, gateDecide, gatePencilDown, gatePencilLifted, gateRequestBypass, gateSettled,
} from '../lib/inkPropGate.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };

console.log('Gate state machine');
check('idle: a prop change is delivered immediately (load, page change, unrelated edits)', () => {
  assert.equal(gateDecide(INK_PROP_GATE_IDLE).deliver, true);
});
check('while the Pencil is down, prop changes are held', () => {
  const s = gatePencilDown(INK_PROP_GATE_IDLE);
  assert.equal(gateDecide(s).deliver, false);
  assert.equal(gateDecide(gateDecide(s).next).deliver, false, 'repeated changes stay held');
});
check('after the Pencil lifts, changes stay held through the settle window, then deliver', () => {
  const lifted = gatePencilLifted(gatePencilDown(INK_PROP_GATE_IDLE));
  assert.equal(gateDecide(lifted).deliver, false);
  assert.equal(gateDecide(gateSettled(lifted)).deliver, true);
});
check('the next stroke re-arms the hold before the settle timer fires (continuous writing never receives a mid-stroke push)', () => {
  const lifted = gatePencilLifted(gatePencilDown(INK_PROP_GATE_IDLE));
  const again = gatePencilDown(lifted);
  assert.equal(again.settling, false);
  assert.equal(gateDecide(again).deliver, false);
});
check('explicit edits (Undo/Redo/Clear/Delete/Duplicate) bypass the hold exactly once', () => {
  const writing = gatePencilDown(INK_PROP_GATE_IDLE);
  const bypassed = gateDecide(gateRequestBypass(writing));
  assert.equal(bypassed.deliver, true);
  assert.equal(gateDecide(bypassed.next).deliver, false, 'bypass is consumed by its delivery');
});

console.log('\nWiring');
const screen = read('app/lecture-material/[lectureId]/[materialId].tsx');
const native = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');
check('the native view receives the GATED prop; export and enable-state keep the FRESH value', () => {
  assert.match(screen, /annotationsByPage=\{nativeAnnotationsProp\}/);
  assert.match(screen, /textAnnotationsByPage=\{nativeTextProp\}/, 'the text prop is re-sent on every store change too, so it is held with the ink prop');
  assert.match(screen, /setNativeTextProp\(nativeTextAnnotationsByPage\)/);
  assert.match(screen, /annotationsByPage: nativeAnnotationsByPage,/);
  assert.match(screen, /nativeAnnotationsByPage\[String\(currentPage\)\]\?\.length/);
});
check('every explicit edit path requests a bypass', () => {
  for (const anchor of ['const applyNativeHistoryStep', "kind: 'page-clear'", "kind: 'selection-change'"]) {
    const at = screen.indexOf(anchor);
    assert.ok(at > 0, anchor);
    assert.match(screen.slice(Math.max(0, at - 300), at + 900), /requestImmediateNativeAnnotations\(\)/, `${anchor} must bypass the hold`);
  }
});
check('a lost "lifted" event cannot freeze native ink updates (failsafe flush)', () => {
  assert.match(screen, /timers\.failsafe = setTimeout\(flushNativeAnnotationsProp, 10000\)/);
});
check('native reports Pencil down/up for ink tools and on cancel/fail', () => {
  assert.match(native, /onPencilActivity\(\["active": true\]\)/);
  assert.equal((native.match(/onPencilActivity\(\["active": false\]\)/g) ?? []).length, 2);
});

console.log('\nSelection outline contract');
check('finishMove clears the drag offset BEFORE the outline is recomputed (no double offset), and never via a late defer', () => {
  const fn = native.slice(native.indexOf('func finishMove()'), native.indexOf('func cancelMove()'));
  assert.doesNotMatch(fn, /defer\s*\{/);
  assert.ok(fn.indexOf('moveOffset = .zero') < fn.indexOf('drawSelectionChrome()'));
  assert.ok(fn.indexOf('moveOffset = .zero') < fn.indexOf('pagedStrokes[number] ='));
});
check('the outline is derived from model geometry + the live offset only, in page space, on one persistent layer', () => {
  const fn = native.slice(native.indexOf('private func drawSelectionChrome()'), native.indexOf('func refreshSelectionChrome()'));
  assert.match(fn, /selectedPageBounds\(\)/);
  assert.match(fn, /offsetBy\(dx: moveOffset\.x, dy: moveOffset\.y\)/);
  assert.match(fn, /selectionLayer \?\? CAShapeLayer\(\)/);
});

console.log('\nDEV recorder cannot add main-thread IO');
check('the native recorder formats and writes on a background queue only', () => {
  const rec = native.slice(native.indexOf('final class InkPerfRecorder'), native.indexOf('final class InkLinkTarget'));
  assert.match(rec, /DispatchQueue\(label: "youmi\.ink-perf", qos: \.utility\)/);
  const endStroke = rec.slice(rec.indexOf('func endStroke('));
  const afterAsync = endStroke.slice(endStroke.indexOf('Self.queue.async'));
  assert.ok(afterAsync.includes('Data(contentsOf: url)') && afterAsync.includes('.write(to: url'));
  assert.ok(!endStroke.slice(0, endStroke.indexOf('Self.queue.async')).includes('.write(to:'));
});
check('the Notebook recorder debounces file IO to after writing stops and is Dev-bundle gated', () => {
  const rec = read('lib/notebookInkPerf.ts');
  assert.match(rec, /setTimeout\(\(\) => \{[\s\S]*ink-perf-notebook\.log[\s\S]*\}, 1500\)/);
  const canvas = read('components/NotebookCanvas.tsx');
  assert.equal((canvas.match(/if \(PENCILKIT_TEST_DEV_ENABLED\) notebookInkPerf\./g) ?? []).length, 6);   // +1: the tap-selects-a-shape branch cancels the perf record
  assert.match(canvas, /onPencilSample=\{handleNativePencilSampleWrapped\}/);
});

console.log('\nmaterial-ink-prop-gate: all checks passed');
