/**
 * Course Material residual stroke flash — stale-JS-snapshot reconciliation.
 *
 * Proven root cause (read-only audit): `AnnotationOverlay.loadAnnotations`
 * unconditionally replaced `pagedStrokes` with whatever `annotationsByPage`
 * JS sent down. JS rebuilds and re-sends that whole prop asynchronously
 * after each `onAnnotationsChanged` commit event; if an OLDER snapshot
 * (captured before that round-trip lands) arrives afterward, it does not
 * yet contain the just-finished native stroke, and the old code deleted it
 * from the native store outright — the stroke visibly disappears until a
 * newer snapshot catches up and re-adds it. That is the flash reported
 * under rapid consecutive handwriting (e.g. "1 1 1 1 1 1 1").
 *
 * The fix tracks `pendingLocalStrokeIds` — ids committed locally via
 * `endStroke()` that no snapshot has echoed back yet — and re-injects any
 * of those missing from an incoming snapshot instead of dropping them.
 * Once a snapshot DOES contain the id, JS is canonical again for it
 * (edits and deletes both take effect), so the pending id is cleared.
 *
 * This is a native Swift file with no XCTest target in this repo (see the
 * existing `material-native-ink-performance.test.mjs` for the established
 * pattern), so these are structural source-level guards on the actual
 * shipped logic, not a mock of it. Native "no visible flash" runtime
 * behavior can only be judged on a real iPad + Apple Pencil.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift', import.meta.url), 'utf8');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const endStroke = source.slice(source.indexOf('  func endStroke('), source.indexOf('  func cancelStroke('));
const eraseSweep = source.slice(source.indexOf('  private func eraseSweep('), source.indexOf('  /// JS calls this immediately before an Undo restores'));
const loadAnnotations = source.slice(source.indexOf('  func loadAnnotations('), source.indexOf('  func loadTextAnnotations('));

console.log('Stroke identity: reconciliation is ID-based (the model already carries UUIDs)');

check('committing a stroke marks its id pending, using the same id emitted to JS', () => {
  assert.match(endStroke, /pendingLocalStrokeIds\.insert\(id\)/);
  assert.match(endStroke, /pagedStrokes\[pageNumber, default: \[\]\]\.append\(stroke\)/);
  assert.ok(endStroke.indexOf('pagedStrokes[pageNumber, default: []].append(stroke)') <
    endStroke.indexOf('pendingLocalStrokeIds.insert(id)'), 'pending mark happens right after the local commit, same id');
});

console.log('Stale snapshot does not delete an unacknowledged local stroke (rapid A/B/C stays visible)');

check('loadAnnotations computes which pending ids the incoming snapshot actually contains', () => {
  assert.match(loadAnnotations, /let loadedIds = Set\(loaded\.values\.flatMap \{ \$0\.map\(\\\.id\) \}\)/);
});

check('a pending id ABSENT from the snapshot is re-injected from the currently-held copy, not dropped', () => {
  const idx = loadAnnotations.indexOf('let loadedIds');
  const body = loadAnnotations.slice(idx);
  assert.match(body, /pendingLocalStrokeIds\.subtract\(loadedIds\)/);
  assert.match(body, /for \(pageNumber, strokes\) in pagedStrokes/, 'source of the re-injected copy is the OLD pagedStrokes, captured before reassignment');
  assert.match(body, /strokes\.filter \{ pendingLocalStrokeIds\.contains\(\$0\.id\) \}/);
  assert.match(body, /loaded\[pageNumber, default: \[\]\]\.append\(contentsOf: survivors\)/);
  assert.ok(body.indexOf('pendingLocalStrokeIds.subtract(loadedIds)') < body.indexOf('pagedStrokes = loaded'),
    'ids are reconciled against the OLD loadedIds before pagedStrokes is overwritten');
});

check('re-injection can never duplicate a stroke — it only adds ids NOT already present in the snapshot', () => {
  const idx = loadAnnotations.indexOf('let loadedIds');
  const guardBody = loadAnnotations.slice(idx, loadAnnotations.indexOf('pagedStrokes = loaded'));
  assert.match(guardBody, /pendingLocalStrokeIds\.subtract\(loadedIds\)/,
    'ids already in the snapshot are removed from the pending set BEFORE the re-injection loop runs, so they cannot be added a second time');
});

console.log('A snapshot that DOES acknowledge a stroke makes JS canonical again (edits/deletes still win)');

check('once loadedIds contains a previously-pending id, it is no longer protected — no indefinite ghost', () => {
  assert.match(loadAnnotations, /pendingLocalStrokeIds\.subtract\(loadedIds\)/,
    'acknowledged ids are unconditionally removed from the pending set every call — there is no timer, no retry budget, no ghost state');
});

check('no arbitrary timers were introduced to hide the flash', () => {
  assert.doesNotMatch(loadAnnotations, /Timer|DispatchQueue.*asyncAfter|setTimeout/);
});

console.log('Intentional delete still wins even for a not-yet-acknowledged stroke');

check('eraseSweep clears unacknowledged additions and adds deletion tombstones before removing, so stale snapshots cannot resurrect them', () => {
  assert.match(eraseSweep, /pendingLocalStrokeIds\.subtract\(removedIds\)/);
  assert.match(eraseSweep, /pendingLocalEraseIds\.formUnion\(removedIds\)/);
  assert.match(eraseSweep, /strokes\.removeAll \{ removed\.contains\(\$0\.id\) \}/);
  assert.ok(eraseSweep.indexOf('pendingLocalEraseIds.formUnion(removedIds)') <
    eraseSweep.indexOf('strokes.removeAll'), 'tombstone exists before actual native removal');
});

check('loadAnnotations filters an older snapshot while its erased ids remain pending, then acknowledges their absence', () => {
  assert.match(loadAnnotations, /let acknowledgedEraseIds = pendingLocalEraseIds\.subtracting\(loadedIds\)/);
  assert.match(loadAnnotations, /pendingLocalEraseIds\.subtract\(acknowledgedEraseIds\)/);
  assert.match(loadAnnotations, /filter \{ !pendingLocalEraseIds\.contains\(\$0\.id\) \}/);
});

check('an intentional Undo can clear only the erase tombstone before restoring its snapshot', () => {
  assert.match(source, /func markStrokeRestorationIntent\(ids: \[String\]\)[\s\S]*?pendingLocalEraseIds\.subtract\(ids\)/);
});

console.log('Existing annotation persistence format and layer-reuse optimization are untouched');

check('the JS-facing annotation payload shape (id/tool/color/width/opacity/points/createdAt) is unchanged', () => {
  assert.match(source, /"id": stroke\.id,\s*\n\s*"tool": stroke\.tool,\s*\n\s*"color": stroke\.color,\s*\n\s*"width": stroke\.width,\s*\n\s*"opacity": stroke\.opacity,\s*\n\s*"points": stroke\.points\.map/);
});

check('same-id layer-reuse diffing (added before this fix) still runs after reconciliation, unmodified in intent', () => {
  assert.match(loadAnnotations, /old\.points == stroke\.points && old\.color == stroke\.color/);
});

console.log(`\nmaterial-annotation-stale-snapshot: ${passed} checks passed`);
