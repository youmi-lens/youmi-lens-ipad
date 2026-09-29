/**
 * PK4-C2B — Course Material ink feel: live/committed stroke policy must match
 * Notebook's production path (lib/notebookStroke.ts), redraw storms must be
 * guarded, and the DEV recorder must stay bounded and out of the sandbox's
 * persistent data. The geometry itself is executed by the native simulator
 * fixture (scripts/material-native-selection.test.mjs: INK_GEOMETRY_PASS,
 * INK_RESEND_NOOP_PASS); this test guards the source-level contracts.
 * Run: node scripts/course-material-ink-feel.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };

const notebookStroke = read('lib/notebookStroke.ts');
const swift = read('modules/expo-pdf-annotation/ios/PdfAnnotationView.swift');

console.log('Notebook reference policy');
const notebookMin = Number(notebookStroke.match(/NOTEBOOK_MIN_POINT_DISTANCE = ([0-9.]+)/)[1]);
check('Notebook reference: quadratic midpoints + minimum sample distance', () => {
  assert.equal(notebookMin, 1.8);
  assert.match(notebookStroke, /Q \$\{points\[i\]\.x\} \$\{points\[i\]\.y\} \$\{midX\} \$\{midY\}/);
});

console.log('\nCourse Material native ink adopts the same policy');
check('minimum sample distance equals Notebook\'s, applied in screen points (scale-aware)', () => {
  assert.match(swift, new RegExp(`let minimumDistance = ${notebookMin} / max\\(0\\.01, pdfView\\.scaleFactor\\)`));
});
check('stroke geometry is quadratic-midpoint with a trailing line, not a raw polyline', () => {
  const layer = swift.slice(swift.indexOf('final class PageInkStrokeLayer'), swift.indexOf('final class PageTextAnnotationLayer'));
  assert.match(layer, /committed\.addQuadCurve\(to: mid, control: previous\)/);
  assert.match(layer, /let mid = CGPoint\(x: \(previous\.x \+ point\.x\) \/ 2, y: \(previous\.y \+ point\.y\) \/ 2\)/);
  assert.match(layer, /drawn\.addLine\(to: tip\)/);
  assert.doesNotMatch(layer, /path\.addLine\(to: point\)/);
});
check('one touch event = one batched append (one CATransaction, one path assignment)', () => {
  assert.equal((swift.match(/annotationOverlay\.appendPoints\(at: recognizer\.confirmedPoints\)/g) ?? []).length, 2);
  assert.doesNotMatch(swift, /for point in recognizer\.confirmedPoints \{ annotationOverlay\.appendPoint\(at: point\) \}/);
  const layer = swift.slice(swift.indexOf('func append(contentsOf points'), swift.indexOf('final class PageTextAnnotationLayer'));
  assert.equal((layer.match(/CATransaction\.begin\(\)/g) ?? []).length, 1);
});

console.log('\nRedraw storms');
check('loadAnnotations short-circuits identical content instead of invalidating the overlay', () => {
  const load = swift.slice(swift.indexOf('func loadAnnotations('), swift.indexOf('func stageTextCommit('));
  assert.match(load, /if loaded == pagedStrokes \{\s*perf\.loadSkipped \+= 1\s*return\s*\}/);
  assert.ok(load.indexOf('if loaded == pagedStrokes') < load.indexOf('setNeedsDisplay()'));
});
check('stroke equality is render identity: createdAt cannot defeat the guard', () => {
  const eq = swift.slice(swift.indexOf('struct AnnotationStroke'), swift.indexOf('struct TextAnnotation'));
  assert.match(eq, /static func == \(a: AnnotationStroke, b: AnnotationStroke\) -> Bool/);
  assert.doesNotMatch(eq.slice(eq.indexOf('static func ==')), /createdAt/);
});

console.log('\nDEV recorder is bounded and non-invasive');
check('recorder only runs in the Dev bundle, writes to Caches (not Documents/Application Support), and is size-capped', () => {
  const rec = swift.slice(swift.indexOf('final class InkPerfRecorder'));
  assert.match(rec, /hasSuffix\("\.dev"\)/);
  assert.match(rec, /\.cachesDirectory/);
  assert.doesNotMatch(rec, /documentDirectory|applicationSupportDirectory/);
  assert.match(rec, /48 \* 1024/);
  assert.match(rec, /guard Self\.enabled else \{ return \}/);
  assert.equal((rec.match(/String\(format: "%@ surface=material mode/g) ?? []).length, 1, 'exactly one line per stroke');
});
check('every stroke path that starts the recorder also stops it (no leaked display link)', () => {
  assert.match(swift, /inkRecorder\.beginStroke\(/);
  assert.match(swift, /inkRecorder\.endStroke\(commitMs:/);
  // empty stroke, a tap that selected a shape (no ink), and cancelled/failed
  assert.equal((swift.match(/inkRecorder\.cancel\(\)/g) ?? []).length, 3);
});

console.log('\nUntouched contracts');
check('committed stroke data shape and export are not migrated by this phase', () => {
  const module = read('modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');
  assert.doesNotMatch(module, /InkPerf|appendPoints/);
  assert.match(swift, /pendingLocalStrokeIds\.insert\(id\)/);
});

console.log('\ncourse-material-ink-feel: all checks passed');
