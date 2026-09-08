/**
 * Course Material: Pencil stroke / double-tap viewport jump back to page 1-2.
 *
 * PROVEN ROOT CAUSE (forensic Metro trace, one physical repro run):
 *
 *   seq 407  annotation-committed  page=7 offsetY=4842 currentPage=7
 *                                  restorationComplete=TRUE  restoring=FALSE
 *   (JS)     native-annotation-commit-received / -store-update / persist-write
 *   seq 408  scroll-bounds         offsetY=-45  currentPage=1
 *                                  restorationComplete=FALSE restoring=TRUE
 *   seq 411  goTo  reason="viewport restore page"
 *
 * The last healthy state and the first bad state are separated only by a JS
 * re-render. `restorationComplete` can only go true -> false in
 * initialViewport's didSet: applyInitialViewportIfPossible() is itself
 * guarded by `!restorationComplete`, so every other caller (layoutSubviews,
 * document load, retry) is inert once a restore has completed. That didSet
 * cleared the flag and re-entered the restore, bypassing the guard.
 *
 * `initialViewport` is frozen at mount on the JS side (useState with no
 * setter), i.e. it means "the viewport this screen was OPENED at". Under the
 * New Architecture the prop setter still runs on every re-render, so every
 * re-render re-armed a restore back to the MOUNT viewport — discarding
 * wherever the user had scrolled to. That is why the destination is
 * "typically page 1/2": it is the page the material was opened at.
 *
 * Both reported repros reduce to "the screen re-rendered":
 *   - an ordinary Pencil stroke  -> annotation store update + persist-write
 *   - an Apple Pencil double-tap -> annotationMode state change
 * which is exactly why the jump was never stroke-content-specific.
 *
 * FIX: an equality guard in initialViewport's didSet — the direct counterpart
 * of the `if initialPage != oldValue` guard that initialPage already had and
 * this property was missing. Re-applying an unchanged target is now a no-op;
 * a genuinely new target still re-arms exactly as before.
 *
 * Native Swift with no XCTest target in this repo — structural source guards,
 * same established pattern as material-viewport-preservation.test.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../app/lecture-material/[lectureId]/[materialId].tsx', import.meta.url), 'utf8');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const didSet = source.slice(
  source.indexOf('var initialViewport: [String: Any]? {'),
  source.indexOf('/// "scroll", "pen", "highlighter", or "eraser".'),
);

console.log('Root cause — a re-applied, UNCHANGED initialViewport must not re-arm the restore');

check('initialViewport parses the payload into a comparable target before mutating any restore state', () => {
  assert.match(didSet, /let parsed = \(\s*\n\s*pageIndex: max\(1, Int\(page\)\),/);
  assert.match(didSet, /scale: max\(0\.01, CGFloat\(scale\)\),/);
  assert.match(didSet, /anchor: CGPoint\(x: max\(0, x\), y: max\(0, y\)\)/);
});

check('an unchanged target returns early — WITHOUT clearing restorationComplete/restoreVerified and WITHOUT calling applyInitialViewportIfPossible', () => {
  const guardIdx = didSet.indexOf('if let pending = pendingInitialViewport,');
  assert.ok(guardIdx > 0, 'equality guard must exist');
  const guardBlock = didSet.slice(guardIdx, didSet.indexOf('pendingInitialViewport = parsed'));
  assert.match(guardBlock, /pending\.pageIndex == parsed\.pageIndex/);
  assert.match(guardBlock, /pending\.scale == parsed\.scale/);
  assert.match(guardBlock, /pending\.anchor == parsed\.anchor/);
  assert.match(guardBlock, /return/, 'must return early');
  assert.doesNotMatch(guardBlock, /restorationComplete = false/, 'the ignored path must not clear the completion flag — that is the exact bug');
  assert.doesNotMatch(guardBlock, /restoreVerified = false/);
  assert.doesNotMatch(guardBlock, /applyInitialViewportIfPossible\(\)/, 'the ignored path must not re-enter the restore');
});

check('the equality guard runs BEFORE restorationComplete is cleared — order is what makes it effective', () => {
  const guardIdx = didSet.indexOf('if let pending = pendingInitialViewport,');
  const clearIdx = didSet.indexOf('restorationComplete = false');
  assert.ok(guardIdx > 0 && clearIdx > 0 && guardIdx < clearIdx);
});

check('a genuinely NEW target still re-arms the restore — accepted mount/restore behaviour is preserved', () => {
  const acceptIdx = didSet.indexOf('pendingInitialViewport = parsed');
  const accepted = didSet.slice(acceptIdx);
  assert.match(accepted, /restorationComplete = false/);
  assert.match(accepted, /restoreVerified = false/);
  assert.match(accepted, /applyInitialViewportIfPossible\(\)/);
});

check('first application after mount still restores: pendingInitialViewport starts nil, so the guard cannot short-circuit it', () => {
  assert.match(source, /private var pendingInitialViewport: \(pageIndex: Int, scale: CGFloat, anchor: CGPoint\)\?/, 'must remain optional, defaulting to nil');
  assert.match(didSet, /if let pending = pendingInitialViewport,/, 'guard is conditional on a previously-set target');
});

check('an invalid/nil payload is still rejected before any state change, unchanged', () => {
  const rejectIdx = didSet.indexOf('REJECTED (invalid/nil payload)');
  const parsedIdx = didSet.indexOf('let parsed = (');
  assert.ok(rejectIdx > 0 && rejectIdx < parsedIdx, 'payload validation still precedes parsing');
});

console.log('\nThe restore entry points this fix relies on are unchanged');

check('applyInitialViewportIfPossible is still guarded by !restorationComplete — so layout/document/retry callers stay inert after a completed restore', () => {
  const fn = source.slice(source.indexOf('private func applyInitialViewportIfPossible() {'));
  assert.match(fn, /guard !restorationComplete, !isRestoringViewport, let document,/);
});

check('initialPage keeps its own pre-existing equality guard (the pattern this fix mirrors)', () => {
  assert.match(source, /if initialPage != oldValue \{ applyInitialPageIfPossible\(\) \}/);
});

check('a re-arm is traced through the forensic bridge, so any future re-arm is unmistakable in a physical capture', () => {
  assert.match(didSet, /traceViewportMutation\("native-prop-initialViewport-rearm"/);
});

console.log('\nThe JS contract this depends on — initialViewport is a mount-frozen value');

check('the screen still freezes initialViewport at mount (useState, no setter) — the fix assumes and preserves this', () => {
  assert.match(screen, /const \[initialViewport\] = useState<NativePdfViewport \| undefined>\(\(\) =>/);
  assert.match(screen, /initialViewport=\{initialViewport\}/);
});

check('accepted persistence is untouched: the screen still captures/persists viewport and still restores on reopen', () => {
  assert.match(screen, /const \[initialPage\] = useState<number>\(\(\) => Math\.max\(1, initialViewport\?\.pageIndex \?\? initialLinkedPage\)\);/);
  assert.match(screen, /beforeRemove/, 'authoritative leave capture still present');
});

console.log(`\nmaterial-viewport-rearm-guard: ${passed} checks passed`);
