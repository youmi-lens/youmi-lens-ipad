/**
 * Floating caption long-run heat/jank fix — render isolation.
 *
 * Real classroom observation: over a long recording, the iPad warms up and
 * FloatingMiniCaption becomes progressively janky while Pencil handwriting
 * (native, off the JS thread) stays smooth — pointing at a sustained JS/React
 * overlay cost, not native PDF/ink rendering.
 *
 * Diagnostic data (a real ~56-minute physical test, heavy Course Material
 * fixture) confirmed the ~4-6 renders/sec is driven by the recording
 * duration ticking every ~250ms (lib/recordingNotes.tsx's context value is a
 * single useMemo keyed on, among other things, currentDurationMillis — every
 * consumer of useRecordingNotes() re-renders on every tick), even though
 * FloatingMiniCaption only ever displays the floored second
 * (Math.floor(currentDurationMillis / 1000)). The same data showed the
 * isolated captionLines.filter() cost was always trivial (<0.1ms) — the real
 * cost was `feedLines` (one row + one NativeLookupText, i.e. one nested Text
 * per English word, per caption line — hundreds deep into a long lecture)
 * being rebuilt as a brand-new array/object graph on every one of those
 * duration-only renders and force-fed into React's reconciler several times
 * a second, for the length of the recording.
 *
 * Fix: memoize feedLines (so a duration-only render produces the identical
 * array reference), and move the actual list rendering into a `memo`-wrapped
 * CaptionFeedList that receives only primitives, stable refs, and a
 * useCallback-stabilized handler — so it can actually bail out on renders
 * where no caption content changed, instead of re-diffing/re-laying-out the
 * whole feed 4-6 times a second regardless of content.
 *
 * Source-level: FloatingMiniCaption is a React Native component with no
 * Node-runnable unit test surface (react-native-safe-area-context,
 * Animated, etc.), so this asserts the actual shipped source implements the
 * required invariants — the same approach already used for
 * legacy-audio-assembly-recovery.test.mjs and other RN-component tests here.
 *
 * RELEASE A NOTE: the original fix's diagnostic filter-cost measurement
 * (`recordFreezeDiagnosticSample`, `lib/courseMaterialFreezeDiagnostics.ts`)
 * is deliberately NOT part of this stabilization release — it was always-on
 * instrumentation for a separate Course Material investigation, not required
 * for this fix. Only the memoization + render-isolation itself is
 * transplanted; the check below now proves the diagnostic module is absent.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const source = read('../components/FloatingMiniCaption.tsx');

console.log('feedLines is memoized, not a plain const rebuilt every render');

check('feedLines is computed inside useMemo, with content-only dependencies (not panelScale/scaled/currentDurationMillis)', () => {
  const idx = source.indexOf('const feedLines = useMemo(');
  assert.ok(idx > 0, 'feedLines must be wrapped in useMemo');
  const block = source.slice(idx, source.indexOf('\n  }, [', idx) + 300);
  assert.match(block, /\}, \[captionLines, currentActiveEnglish, partialCaption, latestFinalLine, translationLine\]\);/);
});

check('the always-on diagnostic instrumentation is NOT part of this release — only the memoization itself was transplanted', () => {
  const idx = source.indexOf('const feedLines = useMemo(');
  const block = source.slice(idx, source.indexOf('}, [captionLines', idx));
  assert.doesNotMatch(block, /recordFreezeDiagnosticSample/, 'diagnostic instrumentation must not ship in Release A');
  assert.doesNotMatch(source, /courseMaterialFreezeDiagnostics/, 'the diagnostic module must not be imported either');
});

console.log('\nThe heavy list is isolated in a memo()-wrapped component with stable props');

check('CaptionFeedList exists and is wrapped in memo()', () => {
  assert.match(source, /const CaptionFeedList = memo\(function CaptionFeedList\(/);
});

check('CaptionFeedList receives only primitives, stable refs, and a callback prop — nothing that is a fresh object/array every render', () => {
  const idx = source.indexOf('const CaptionFeedList = memo(function CaptionFeedList({');
  const propsBlock = source.slice(idx, source.indexOf('}) {', idx));
  // Must NOT receive the whole `scaled` object (a fresh plain object every
  // render) — only its individual numeric fields, which compare by value.
  assert.doesNotMatch(propsBlock, /\bscaled\b/, 'must not receive the whole scaled object — defeats memo shallow comparison');
  assert.match(propsBlock, /rowPaddingX,\s*\n\s*rowPaddingY,/);
  assert.match(propsBlock, /englishSize,\s*\n\s*chineseSize,/);
});

check('the call site passes feedLines and only primitive/stable props to CaptionFeedList', () => {
  const idx = source.indexOf('<CaptionFeedList');
  const call = source.slice(idx, source.indexOf('/>', idx));
  assert.match(call, /feedLines=\{feedLines\}/);
  assert.match(call, /onScrollPositionChange=\{updateAutoFollowFromScroll\}/);
  assert.doesNotMatch(call, /scaled=\{scaled\}/, 'must not pass the whole scaled object');
});

console.log('\nupdateAutoFollowFromScroll has a stable identity (required for the memo above to mean anything)');

check('updateAutoFollowFromScroll is wrapped in useCallback with empty deps (only touches a ref + a state setter)', () => {
  const idx = source.indexOf('const updateAutoFollowFromScroll = useCallback(');
  assert.ok(idx > 0, 'must be useCallback-wrapped, not a plain arrow function recreated every render');
  const block = source.slice(idx, idx + 300);
  assert.match(block, /\}, \[\]\);/, 'deps must be empty — feedMetricsRef is a ref, setAutoFollowFeed is a stable setter');
});

console.log('\nBehavior preservation — same visible product behavior, only render cost changed');

check('the rendered row markup (English text, translation, translating-pending state) is unchanged, just relocated', () => {
  assert.match(source, /styles\.feedLine,\s*\n\s*line\.isActive && styles\.feedLineActive,/);
  assert.match(source, /line\.translatedText \?\? line\.translationZh/);
  assert.match(source, /line\.isActive && translationPending \? \(/);
});

check('the empty-state fallback (CaptionFallbackRow) is still used when feedLines is empty', () => {
  const idx = source.indexOf('const CaptionFeedList = memo(');
  const block = source.slice(idx, source.indexOf('function CaptionFallbackRow', idx));
  assert.match(block, /feedLines\.length > 0 \?/);
  assert.match(block, /<CaptionFallbackRow/);
});

console.log(`\nfloating caption render isolation: ${passed} checks passed`);
