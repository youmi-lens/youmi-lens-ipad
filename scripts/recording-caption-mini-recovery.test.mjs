/**
 * P0 physical-device recovery regressions (diagnosed from live Metro logs):
 *
 *   P0-1  recording start must be decoupled from live captions (recorder first,
 *         captions only after `started`, and never awaited before it).
 *   P0-2  a missing/unconfigured provider key (DASHSCOPE_KEY_MISSING) must be
 *         FATAL so the caption pipeline stops reconnecting and leaves the
 *         "Connecting…" state — recording is unaffected.
 *   P0-3  NotebookCanvas `contextFade` must animate on the NATIVE driver to match
 *         `toolbarTransition` (they share an opacity node via Animated.multiply);
 *         the JS driver crashed the canvas and garbled the Mini screen.
 *
 * Source-level guards (the functions involved are module-internal); the live
 * behaviour was confirmed against the physical device.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const recording = read('../app/recording.tsx');
const liveCaptions = read('../lib/liveCaptions.tsx');
// PK4-C1 moved the toolbar's contextFade/toolbarTransition Animated values
// (and the Mini screen's own NotebookCanvas render) out of NotebookCanvas.tsx
// into the one shared SharedAnnotationToolbar component both Notebook and
// Course Material render — the driver-consistency invariant this guards now
// lives there.
const notebook = read('../components/SharedAnnotationToolbar.tsx');

console.log('P0-1 — recording decoupled from captions');
check('the recorder starts first; captions only after `started`, never awaited before', () => {
  // startRecording resolves, THEN startCaptionPipeline runs, gated on `started`.
  assert.match(recording, /const started = await startRecording\(\)/);
  assert.match(recording, /if \(started && !isGuest\) (void |await )?startCaptionPipeline\(\)/);
  // No caption connect is awaited before the recorder starts.
  assert.equal(
    /await (startCaptionPipeline|liveCaptions\.connect)[\s\S]{0,200}await startRecording/.test(recording),
    false,
    'captions must never be awaited before the recorder starts',
  );
});

console.log('P0-2 — missing provider key is fatal (no infinite Connecting)');
check('classifyStreamError treats a missing/unconfigured key as fatal', () => {
  const fn = liveCaptions.slice(
    liveCaptions.indexOf('function classifyStreamError'),
    liveCaptions.indexOf('export function LiveCaptionsProvider'),
  );
  assert.match(fn, /key_missing/);
  assert.match(fn, /not configured|missing key|no api key/);
  // The key-missing branch returns fatal: true, and sits BEFORE the transient
  // fall-through so DASHSCOPE_KEY_MISSING can't slip into the reconnect loop.
  const keyBranch = fn.indexOf('key_missing');
  const fallthrough = fn.lastIndexOf("return { reason: 'backend_stream_error', fatal: false }");
  assert.ok(keyBranch > 0 && keyBranch < fallthrough, 'key-missing must be classified before the transient fallback');
});
check('a fatal stream error gives up (exits Connecting → unavailable)', () => {
  assert.match(liveCaptions, /if \(fatal\) \{[\s\S]{0,80}giveUp\(reason\)/);
  assert.match(liveCaptions, /const giveUp = useCallback\([\s\S]{0,700}setStatus\('unavailable'\)/);
});

console.log('P0-3 — NotebookCanvas driver consistency (Mini no longer crashes)');
check('contextFade animates on the native driver, matching toolbarTransition', () => {
  // The contextFade timing block must use the native driver.
  const block = notebook.slice(notebook.indexOf('contextFade.setValue(0)'));
  const timing = block.slice(0, block.indexOf('.start()') + 8);
  assert.match(timing, /useNativeDriver: true/);
  assert.doesNotMatch(timing, /useNativeDriver: false/);
  // toolbarTransition (the node it is multiplied with) is native-driven.
  assert.match(notebook, /toolbarTransition[\s\S]{0,400}useNativeDriver: true/);
  // They are combined for opacity, which is why the drivers must agree.
  assert.match(notebook, /Animated\.multiply\([\s\S]{0,300}contextFade/);
});

console.log(`\nrecording/caption/mini recovery: ${passed} checks passed`);
