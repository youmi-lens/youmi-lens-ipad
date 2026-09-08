/**
 * Regression guards for Course Material's persisted PDFKit reading position.
 * Native PDFKit is deliberately responsible for sampling/restoring; these
 * checks cover the serializable boundary and the structural no-init-write
 * invariants that are unsafe to fake in a JS-only test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMaterialViewport, materialViewportEqual } from '../lib/materialViewport.ts';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const screen = readFileSync(new URL('../app/lecture-material/[lectureId]/[materialId].tsx', import.meta.url), 'utf8');
const swift = readFileSync(new URL('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift', import.meta.url), 'utf8');

console.log('Course Material — persisted last-viewed viewport');

check('versioned viewport round-trips as a serializable PDF-space value', () => {
  const value = { version: 1, pageIndex: 7, scaleFactor: 1.85, anchorX: 116.5, anchorY: 744.25 };
  assert.deepEqual(normalizeMaterialViewport(JSON.parse(JSON.stringify(value)), 12), value);
  assert.ok(materialViewportEqual(value, { ...value }));
});

check('legacy lastOpenedPage remains a safe fallback without a saved viewport', () => {
  assert.deepEqual(normalizeMaterialViewport(undefined, 12, 4), {
    version: 1, pageIndex: 4, scaleFactor: 1, anchorX: 0, anchorY: 0,
  });
  assert.match(screen, /material\?\.lastOpenedViewport,[\s\S]*?\),\n\s*\);/);
  assert.match(screen, /initialViewport\?\.pageIndex \?\? initialLinkedPage/);
});

check('stale pages and invalid coordinates are clamped without crashing', () => {
  assert.deepEqual(normalizeMaterialViewport({ version: 1, pageIndex: 99, scaleFactor: -2, anchorX: -1, anchorY: -5 }, 3), {
    version: 1, pageIndex: 3, scaleFactor: 0.01, anchorX: 0, anchorY: 0,
  });
  assert.equal(normalizeMaterialViewport({ version: 2, pageIndex: 1 }, 3), undefined);
});

check('native restore blocks synthetic initialization writes until the layout restoration completes', () => {
  const restore = swift.slice(swift.indexOf('  private func applyInitialViewportIfPossible()'), swift.indexOf('  private func currentViewportMatchesTarget('));
  assert.match(restore, /guard !restorationComplete, !isRestoringViewport, let document,\s*\n\s*pdfView\.bounds\.width > 0, pdfView\.bounds\.height > 0/);
  assert.match(restore, /pdfView\.go\(to: page\)[\s\S]*pdfView\.scaleFactor[\s\S]*PDFDestination/);
  assert.match(restore, /self\.restorationComplete = true[\s\S]*self\.emitCurrentPage\(\)/);
  const emit = swift.slice(swift.indexOf('  private func emitCurrentPage()'), swift.indexOf('  private func emitError('));
  assert.match(emit, /guard restorationComplete else \{/);
});

console.log('\nLayout-readiness fix (proven from a captured physical run: restore attempts executed with pdfView.bounds == 0×0 across multiple attempts, wasting retry budget before the internal PDFView had any usable layout)');

check('the readiness guard checks pdfView.bounds (the INNER PDFView actually being navigated), not this custom view\'s own outer bounds — the outer view can be non-zero while pdfView is still 0×0', () => {
  const restore = swift.slice(swift.indexOf('  private func applyInitialViewportIfPossible()'), swift.indexOf('  private func currentViewportMatchesTarget('));
  assert.match(restore, /pdfView\.bounds\.width > 0, pdfView\.bounds\.height > 0/);
  assert.doesNotMatch(restore.slice(0, restore.indexOf('else {')), /(?<!pdfView\.)\bbounds\.width > 0\b/, 'the readiness check itself must not fall back to the outer view\'s bare `bounds`');
});

check('a 0×0 pdfView guard-failure returns BEFORE isRestoringViewport/viewportRestoreAttempts are ever touched — a premature call costs nothing against the retry budget', () => {
  const restore = swift.slice(swift.indexOf('  private func applyInitialViewportIfPossible()'), swift.indexOf('  private func currentViewportMatchesTarget('));
  const guardIdx = restore.indexOf('guard !restorationComplete');
  const returnIdx = restore.indexOf('return\n    }', guardIdx);
  const firstAttemptCounterTouch = restore.indexOf('isRestoringViewport = true');
  assert.ok(guardIdx >= 0 && returnIdx > guardIdx && firstAttemptCounterTouch > returnIdx,
    'the early return for an unready pdfView must come strictly before any attempt/reentrancy state is set');
});

check('layoutSubviews() re-triggers the restore attempt on every later layout pass — once pdfView actually gets a size, the very next layout pass starts the real attempt fresh', () => {
  const layoutSubviewsStart = swift.indexOf('public override func layoutSubviews()');
  const layoutSubviews = swift.slice(layoutSubviewsStart, swift.indexOf('private static func double(', layoutSubviewsStart));
  assert.match(layoutSubviews, /applyInitialViewportIfPossible\(\)/);
});

console.log('\nCategory F fix — restore-side reentrancy + verify-before-complete (Build 50 P0: restore reaches the saved page, then an unprompted PDFKit layout pass resets it to page 1)');

check('isRestoringViewport guards against reentrant restore attempts — layoutSubviews() calls applyInitialViewportIfPossible() on every layout pass, and the restore sequence itself (go(to:) + a large scaleFactor change + go(to:) again) triggers further layout passes before the async completion runs', () => {
  assert.match(swift, /private var isRestoringViewport = false/);
  const guardLine = swift.slice(swift.indexOf('  private func applyInitialViewportIfPossible()'), swift.indexOf('  private func currentViewportMatchesTarget('));
  assert.match(guardLine, /guard !restorationComplete, !isRestoringViewport,/);
  assert.match(guardLine, /isRestoringViewport = true/);
});

check('layoutSubviews() is the proven reentrancy source — it calls applyInitialViewportIfPossible() unconditionally on every layout pass', () => {
  const layoutSubviewsStart = swift.indexOf('public override func layoutSubviews()');
  const layoutSubviews = swift.slice(layoutSubviewsStart, swift.indexOf('private static func double(', layoutSubviewsStart));
  assert.match(layoutSubviews, /applyInitialViewportIfPossible\(\)/);
});

check('restorationComplete is only set after the ACTUAL settled viewport is independently verified to match the target — not merely on the next run-loop turn (PDFKit can defer layout/re-tiling past a large scaleFactor change)', () => {
  const restore = swift.slice(swift.indexOf('  private func applyInitialViewportIfPossible()'), swift.indexOf('  private func currentViewportMatchesTarget('));
  assert.match(restore, /let matches = self\.currentViewportMatchesTarget\(pageIndex: pageIndex, saved: saved\)/);
  const verifyIdx = restore.indexOf('let matches =');
  const completeIdx = restore.indexOf('self.restorationComplete = true');
  assert.ok(verifyIdx >= 0 && completeIdx > verifyIdx, 'verification must happen before restorationComplete is set');
});

check('a mismatch retries the restore, bounded by maxViewportRestoreAttempts — never an unbounded/recurring-timer loop', () => {
  assert.match(swift, /private static let maxViewportRestoreAttempts = 3/);
  const restore = swift.slice(swift.indexOf('  private func applyInitialViewportIfPossible()'), swift.indexOf('  private func currentViewportMatchesTarget('));
  assert.match(restore, /if !matches, self\.viewportRestoreAttempts < Self\.maxViewportRestoreAttempts \{/);
  assert.doesNotMatch(restore, /asyncAfter|Timer\.scheduledTimer/, 'must not use an arbitrary sleep/timer to paper over the race');
});

check('exhausting the retry bound still completes restoration (never leaves the view permanently stuck suppressed) and resets the attempt counter for the next restore cycle', () => {
  const restore = swift.slice(swift.indexOf('  private func applyInitialViewportIfPossible()'), swift.indexOf('  private func currentViewportMatchesTarget('));
  const giveUp = restore.slice(restore.indexOf('self.isRestoringViewport = false\n      self.viewportRestoreAttempts = 0'));
  assert.match(giveUp, /self\.restorationComplete = true/);
  assert.match(giveUp, /self\.emitCurrentPage\(\)/);
});

check('currentViewportMatchesTarget checks page, scale (5% tolerance), and the VERTICAL PDF-space anchor (20pt tolerance) only — not horizontal, and not page alone', () => {
  const start = swift.indexOf('private func currentViewportMatchesTarget(');
  const fn = swift.slice(start, swift.indexOf('private func currentViewport()', start));
  assert.match(fn, /current\.pageIndex == pageIndex/);
  assert.match(fn, /saved\.scale \* 0\.05/);
  assert.match(fn, /abs\(current\.anchor\.y - saved\.anchor\.y\) <= 20/);
  assert.doesNotMatch(fn, /current\.anchor\.x|saved\.anchor\.x|hypot\(/, 'horizontal anchor must not be COMPARED (the doc comment explaining why it is excluded may still mention anchor.x as text) — proven to be a centering artifact, not a user-scroll signal, for this narrower-than-viewport singlePageContinuous/.vertical document');
});

console.log('\nFailed-restore protection (proven from a captured physical run: verify matches=false on a real horizontal-anchor mismatch, then retry exhaustion still flipped restorationComplete=true, which was the only gate emission checked)');

check('restoreVerified is set from the ACTUAL match result, not assumed true merely because the retry budget was exhausted', () => {
  assert.match(swift, /private var restoreVerified = false/);
  const restore = swift.slice(swift.indexOf('  private func applyInitialViewportIfPossible()'), swift.indexOf('  private func currentViewportMatchesTarget('));
  assert.match(restore, /self\.restoreVerified = matches/);
  const setIdx = restore.indexOf('self.restoreVerified = matches');
  const completeIdx = restore.indexOf('self.restorationComplete = true');
  assert.ok(completeIdx < setIdx, 'restorationComplete flips true (stop attempting) regardless of the outcome, but restoreVerified is set separately from the real match result — they are not the same bit');
});

check('emission (onViewportChanged / captureViewportPayload) is gated on viewportTrustedForEmission (restoreVerified || userHasInteracted), never on restorationComplete alone — this is what actually protects the saved viewport after a failed restore', () => {
  assert.match(swift, /private var viewportTrustedForEmission: Bool \{ restoreVerified \|\| userHasInteracted \}/);
  const emitSnapshot = swift.slice(swift.indexOf('private func emitViewportSnapshot()'), swift.indexOf('private func scheduleViewportSnapshot()'));
  assert.match(emitSnapshot, /guard restorationComplete, viewportTrustedForEmission, let snapshot = currentViewport\(\) else \{ return \}/);
  const captureStart = swift.indexOf('func captureViewportPayload()');
  const capture = swift.slice(captureStart, swift.indexOf('private func goToPage(', captureStart));
  assert.match(capture, /guard viewportTrustedForEmission, let snapshot = currentViewport\(\) else \{/);
  assert.match(capture, /return \[:\]/);
});

check('a failed restore that exhausts its retry budget therefore returns [:] from captureViewportPayload (leave-time read) and emits nothing from emitViewportSnapshot (background debounce read) — a synthetic layout-driven page/scale change in this state cannot reach JS, so it cannot overwrite the saved-good viewport', () => {
  // restoreVerified stays false when matches=false even after exhausting
  // retries (proven above); viewportTrustedForEmission is false whenever
  // both restoreVerified and userHasInteracted are false — so every
  // emission path is blocked until one of those two becomes true.
  assert.match(swift, /private var viewportTrustedForEmission: Bool \{ restoreVerified \|\| userHasInteracted \}/);
});

check('explicit user pan/pinch gesture (.began), not PDFViewPageChanged, is what lifts protection — PDFKit itself fires PDFViewPageChanged during layout/restore, so it cannot be trusted as a real-user-interaction signal', () => {
  assert.match(swift, /private var userHasInteracted = false/);
  const handler = swift.slice(swift.indexOf('@objc private func handleUserScrollGesture'), swift.indexOf('@objc private func handleUserScrollGesture') + 400);
  assert.match(handler, /guard recognizer\.state == \.began, !userHasInteracted else \{ return \}/);
  assert.match(handler, /userHasInteracted = true/);
  const start = swift.indexOf('private func startObservingScroll()');
  const observing = swift.slice(start, swift.indexOf('private func findInnerScrollView('));
  assert.match(observing, /scroll\.panGestureRecognizer\.addTarget\(self, action: #selector\(handleUserScrollGesture/);
  assert.match(observing, /scroll\.pinchGestureRecognizer\?\.addTarget\(self, action: #selector\(handleUserScrollGesture/);
  assert.doesNotMatch(handler, /PDFViewPageChanged/, 'must not derive the user-interaction signal from PDFKit\'s own page-changed notification');
});

check('restoreVerified/userHasInteracted reset to false on a genuinely new document load and on a new restore target — a reused view instance never inherits trust from a previous document', () => {
  const load = swift.slice(swift.indexOf('self.sourceDocument = pdfDocument'), swift.indexOf('self.sourceDocument = pdfDocument') + 700);
  assert.match(load, /self\.restoreVerified = false/);
  assert.match(load, /self\.userHasInteracted = false/);
  const didSetStart = swift.indexOf('var initialViewport: [String: Any]?');
  const didSet = swift.slice(didSetStart, didSetStart + 900);
  assert.match(didSet, /restoreVerified = false/);
});

check('latest native snapshot wins before the debounce flush', () => {
  const handler = screen.slice(screen.indexOf('  const handleNativeViewportChanged'), screen.indexOf('  const handlePdfError'));
  assert.match(handler, /pendingViewportRef\.current = viewport;[\s\S]*scheduleViewportPersist\(\)/);
  const flush = screen.slice(screen.indexOf('  const flushViewportToStore'), screen.indexOf('  const scheduleViewportPersist'));
  assert.match(flush, /const viewport = pendingViewportRef\.current;[\s\S]*lastOpenedViewport: viewport/);
});

check('writes are material-scoped and preserve appended-page identities', () => {
  assert.match(screen, /updateMaterial\(id, \{ lastOpenedPage: viewport\.pageIndex, lastOpenedViewport: viewport \}\)/);
  assert.match(screen, /compositePageCount\(material\?\.sourcePageCount[\s\S]*material\?\.appendedPageCount/);
  assert.doesNotMatch(screen.slice(screen.indexOf('  const flushViewportToStore'), screen.indexOf('  const scheduleViewportPersist')), /updateLectureMaterialLink/);
});

check('leave and background both persist the AWAITED native capture result, not a fire-and-log snapshot racing the debounced JS ref', () => {
  // This is the exact Build 50 defect: captureViewport()'s resolved value
  // was only logged, and flushViewportToStore() ran synchronously right
  // after firing (not awaiting) that promise — so a fast "jump to page 19,
  // then immediately leave" persisted whatever stale snapshot the ~350ms
  // native + 500ms JS debounce had last delivered, not the true current
  // page. persistAuthoritativeViewport must set pendingViewportRef.current
  // from the RESOLVED native capture, and flushViewportToStore must only
  // run inside .then()/.finally() — never synchronously alongside the call.
  const helper = screen.slice(screen.indexOf('  const persistAuthoritativeViewport'), screen.indexOf('  }, [flushViewportToStore, useNativePdfViewer]);') + 60);
  assert.match(helper, /nativePdf\.captureViewport\(\)\s*\n\s*\.then\(\(nativeViewport\) => \{/);
  assert.match(helper, /if \(normalized\) pendingViewportRef\.current = normalized;/);
  assert.match(helper, /\.finally\(\(\) => \{\s*\n\s*flushViewportToStore\(\);/);

  const cleanup = screen.slice(screen.indexOf('  // On unmount, flush any pending page write'), screen.indexOf('  const fileUri ='));
  assert.match(cleanup, /persistAuthoritativeViewport\(nativePdf\)/);
  assert.doesNotMatch(cleanup, /flushViewportToStore\(\);\s*\n\s*if \(navigatorHideTimerRef/, 'flushViewportToStore must not run synchronously right after the native capture is fired — only via persistAuthoritativeViewport');
  assert.match(cleanup, /AppState\.addEventListener\('change'/);
  assert.match(cleanup, /persistAuthoritativeViewport\(pdfRef\.current\)/);
});

console.log('\nbeforeRemove authoritative leave capture (Build 50 P0: unmount cleanup ran too late — proven from a captured physical run that nativeRef.current was already null by cleanup time, so captureViewport() short-circuited in pure JS and never reached native code at all)');

check('useNavigation is imported and beforeRemove is registered as its own effect, separate from the unmount-cleanup effect', () => {
  assert.match(screen, /import \{ useLocalSearchParams, useNavigation, useRouter \} from 'expo-router';/);
  assert.match(screen, /const navigation = useNavigation\(\);/);
  assert.match(screen, /navigation\.addListener\('beforeRemove', \(e\) => \{/);
});

check('beforeRemove calls preventDefault and captures via the native ref BEFORE React has any chance to detach it — this is the whole point: the ref is still valid here, unlike in the unmount cleanup', () => {
  const start = screen.indexOf("navigation.addListener('beforeRemove'");
  const end = screen.indexOf('return unsubscribe;', start);
  const body = screen.slice(start, end);
  assert.match(body, /if \(leavePersistenceCompletedRef\.current\) return;/);
  assert.match(body, /e\.preventDefault\(\);/);
  assert.match(body, /const nativePdf = pdfRef\.current;/);
  assert.match(body, /await nativePdf\.captureViewport\(\);/);
  const preventIdx = body.indexOf('e.preventDefault();');
  const refIdx = body.indexOf('const nativePdf = pdfRef.current;');
  assert.ok(preventIdx >= 0 && refIdx > preventIdx, 'the ref must be captured after preventDefault, while still in the synchronous beforeRemove callback');
});

check('the returned native viewport wins over whatever stale JS viewport was already pending, exactly like the other authoritative-capture paths', () => {
  const start = screen.indexOf("navigation.addListener('beforeRemove'");
  const end = screen.indexOf('return unsubscribe;', start);
  const body = screen.slice(start, end);
  assert.match(body, /if \(normalized\) pendingViewportRef\.current = normalized;/);
});

check('a null/thrown native capture falls back safely to flushViewportToStore\'s existing latest-JS-viewport behavior, and navigation ALWAYS proceeds afterward — the user is never trapped on this screen waiting for a native call', () => {
  const start = screen.indexOf("navigation.addListener('beforeRemove'");
  const end = screen.indexOf('return unsubscribe;', start);
  const body = screen.slice(start, end);
  assert.match(body, /catch \(error\) \{/);
  assert.match(body, /before-remove-capture-failed/);
  // flushViewportToStore/dispatch must run unconditionally after the
  // try/catch — not only on the success path.
  const catchEnd = body.indexOf('}\n        }\n', body.indexOf('catch (error)'));
  const afterTryCatch = body.slice(catchEnd);
  assert.match(afterTryCatch, /flushViewportToStore\(\);/);
  assert.match(afterTryCatch, /leavePersistenceCompletedRef\.current = true;/);
  assert.match(afterTryCatch, /navigation\.dispatch\(e\.data\.action\);/);
});

check('no arbitrary sleep/timer is used to work around the race — the fix is a lifecycle boundary (beforeRemove), not a delay', () => {
  const start = screen.indexOf("navigation.addListener('beforeRemove'");
  const end = screen.indexOf('return unsubscribe;', start);
  const body = screen.slice(start, end);
  assert.doesNotMatch(body, /setTimeout|asyncAfter/);
});

check('the reentrancy guard prevents the classic beforeRemove loop: preventDefault -> persist -> dispatch the original action -> beforeRemove fires again for that SAME removal. leavePersistenceCompletedRef is set true before dispatch, so the second firing returns immediately without calling preventDefault again', () => {
  const start = screen.indexOf("navigation.addListener('beforeRemove'");
  const end = screen.indexOf('return unsubscribe;', start);
  const body = screen.slice(start, end);
  const guardIdx = body.indexOf('if (leavePersistenceCompletedRef.current) return;');
  const setTrueIdx = body.indexOf('leavePersistenceCompletedRef.current = true;');
  const dispatchIdx = body.indexOf('navigation.dispatch(e.data.action);');
  assert.ok(guardIdx >= 0 && setTrueIdx > guardIdx && dispatchIdx > setTrueIdx,
    'the ref must be set true BEFORE re-dispatching, so the re-triggered beforeRemove sees it already true');
});

check('background persistence (AppState) is untouched and still calls persistAuthoritativeViewport directly on the live native ref — beforeRemove is additive, not a replacement for the background path', () => {
  const appStateEffect = screen.slice(screen.indexOf("AppState.addEventListener('change'"), screen.indexOf("navigation.addListener('beforeRemove'"));
  assert.match(appStateEffect, /persistAuthoritativeViewport\(pdfRef\.current\);/);
});

check('the unmount-cleanup effect treats its own capture as a last-resort fallback: if beforeRemove already persisted for this leave, unmount skips its own (now-redundant, ref-likely-null) capture entirely rather than risk clobbering the newer save', () => {
  const cleanup = screen.slice(screen.indexOf('  // On unmount, flush any pending page write'), screen.indexOf('  const fileUri ='));
  assert.match(cleanup, /if \(leavePersistenceCompletedRef\.current\) \{/);
  const skipIdx = cleanup.indexOf('if (leavePersistenceCompletedRef.current) {');
  const persistIdx = cleanup.indexOf('persistAuthoritativeViewport(nativePdf);');
  assert.ok(skipIdx >= 0 && persistIdx > skipIdx, 'the skip-check must come before the fallback capture call, so it can actually prevent it');
});

console.log(`\nmaterial-last-viewed-position: ${passed} checks passed`);
