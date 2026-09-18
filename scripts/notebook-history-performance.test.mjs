/**
 * Regression guard for the Notes-heavy freeze fix (Build 50 P0-1).
 *
 * Root cause: recordHistory() ran before every committed stroke/erase/move and
 * deep-cloned the ENTIRE strokes+images document (every point of every stroke)
 * into the undo stack on every single commit — O(total points so far) per
 * commit, i.e. quadratic over a session, synchronous on the JS thread. The fix
 * (components/NotebookCanvas.tsx) makes snapshot capture a shallow array copy
 * instead, since no code anywhere mutates a committed NoteStroke's `points` (or
 * a NoteImage) in place — every commit path already replaces arrays/objects
 * wholesale via spread/map/filter.
 *
 * These are structural/invariant checks, not wall-clock timing — the claim
 * being protected is "snapshot capture is O(stroke count), never O(point
 * count)", which is provable from source shape, not from how fast a machine
 * happens to run today.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const src = read('../components/NotebookCanvas.tsx');

console.log('History snapshot no longer deep-clones stroke points');

check('cloneStroke (the per-point deep clone) has been removed entirely', () => {
  assert.doesNotMatch(src, /function cloneStroke\(/, 'the deep-clone-every-point helper must not exist');
});

check('cloneSnapshot copies strokes/images by shallow array reference, not by deep-cloning each one', () => {
  const fn = src.slice(src.indexOf('function cloneSnapshot('), src.indexOf('/** Ray-casting point-in-polygon'));
  assert.match(fn, /strokes:\s*snapshot\.strokes\.slice\(\)/, 'strokes must be a shallow .slice(), not a per-stroke map');
  assert.match(fn, /images:\s*snapshot\.images\.slice\(\)/, 'images must be a shallow .slice(), not a per-image map');
  assert.doesNotMatch(fn, /\.map\(cloneStroke\)/, 'must not still map every stroke through a deep clone');
  assert.doesNotMatch(fn, /points\.map\(/, 'must never iterate every point while building a snapshot');
});

check('cloneImage is retained only for the single active image-gesture baseline, not the undo/redo path', () => {
  assert.match(src, /function cloneImage\(image: NoteImage\)/, 'cloneImage still exists (flat object, cheap, unrelated to strokes)');
  const cloneImageUses = [...src.matchAll(/\bcloneImage\(/g)];
  assert.equal(cloneImageUses.length, 2, 'exactly one definition + one call site (the image gesture-start snapshot) — none in the undo/redo path');
  assert.match(src, /image:\s*cloneImage\(image\)/, 'the one call site is the image gesture-start baseline');
});

console.log('The optimization is safe: nothing mutates committed stroke/image data in place');

check('no code path mutates a NoteStroke.points array element in place', () => {
  assert.doesNotMatch(src, /\.points\[[^\]]*\]\s*=(?!=)/, 'no indexed point assignment');
  assert.doesNotMatch(src, /\.points\.push\(/, 'no push onto an existing points array');
  assert.doesNotMatch(src, /\.points\.splice\(/, 'no splice onto an existing points array');
  assert.doesNotMatch(src, /\bpoint\.x\s*=(?!=)/, 'no in-place point.x mutation');
  assert.doesNotMatch(src, /\bpoint\.y\s*=(?!=)/, 'no in-place point.y mutation');
});

check('commitStroke appends via spread into a NEW array — never mutates strokesRef.current in place', () => {
  const fn = src.slice(src.indexOf('const commitStroke = useCallback('), src.indexOf('const publishEraseSuppression = useCallback('));
  assert.match(fn, /onStrokesChangeRef\.current\(\[\.\.\.strokesRef\.current, stroke\]\)/, 'new stroke is appended into a fresh array');
  assert.doesNotMatch(fn, /strokesRef\.current\.push/, 'must never push onto the live array');
});

check('commitErase filters into a NEW array — never mutates strokesRef.current in place', () => {
  const fn = src.slice(src.indexOf('const commitErase = useCallback('), src.indexOf('/**\n   * End the live stroke'));
  assert.match(fn, /strokesRef\.current\.filter\(/, 'erase produces a filtered copy');
});

check('commitMove maps into a NEW array — untouched strokes keep their same object reference', () => {
  const fn = src.slice(src.indexOf('const commitMove = useCallback('), src.indexOf('// Commit the in-progress stroke'));
  assert.match(fn, /strokesRef\.current\.map\(\(s\) =>\s*\n\s*ids\.has\(s\.id\)/, 'move maps the array, replacing only selected strokes');
  assert.match(fn, /:\s*s,?\s*\n\s*\);/, 'a stroke NOT in the selection is returned as-is (same reference) — the exact property that makes shallow snapshot sharing safe');
});

console.log('recordHistory still fires at every commit — undo/redo wiring is unchanged, only its storage cost is');

check('recordHistory() is still called before commitStroke, commitErase, and commitMove each mutate state', () => {
  const commitStrokeFn = src.slice(src.indexOf('const commitStroke = useCallback('), src.indexOf('const publishEraseSuppression = useCallback('));
  assert.match(commitStrokeFn, /recordHistory\(\);/, 'commitStroke still records history before mutating');
  const commitEraseFn = src.slice(src.indexOf('const commitErase = useCallback('), src.indexOf('/**\n   * End the live stroke'));
  assert.match(commitEraseFn, /recordHistory\(\);/, 'commitErase still records history before mutating');
  const commitMoveFn = src.slice(src.indexOf('const commitMove = useCallback('), src.indexOf('// Commit the in-progress stroke'));
  assert.match(commitMoveFn, /recordHistory\(\);/, 'commitMove still records history before mutating');
});

check('undo/redo still restore through applySnapshot, which still clones (isolates) before handing content back', () => {
  const applySnapshotFn = src.slice(src.indexOf('const applySnapshot = useCallback('), src.indexOf('const undo = useCallback('));
  assert.match(applySnapshotFn, /const next = cloneSnapshot\(snap\)/, 'restore still isolates the popped snapshot via cloneSnapshot');
  assert.match(applySnapshotFn, /onStrokesChangeRef\.current\(next\.strokes\)/, 'restore still hands the restored strokes back to the parent');
  assert.match(applySnapshotFn, /onImagesChangeRef\.current\(next\.images\)/, 'restore still hands the restored images back to the parent');
});

check('HISTORY_MAX still bounds stack length (unchanged) — this fix removes the per-push cost, not the depth cap', () => {
  assert.match(src, /const HISTORY_MAX = 60;/);
});

console.log(`\nnotebook-history-performance: ${passed} checks passed`);
