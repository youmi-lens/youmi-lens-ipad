/**
 * Notebook viewport / palm-lock / pinch-zoom pure helpers.
 * Run: node --experimental-strip-types scripts/notebook-viewport.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NOTEBOOK_DEFAULT_SCALE,
  NOTEBOOK_MAX_SCALE,
  NOTEBOOK_MIN_SCALE,
  NOTEBOOK_PALM_GRACE_MS,
  applyPinchZoomFromStart,
  canvasToScreenX,
  clampNotebookScale,
  clampNotebookScrollY,
  clampNotebookTranslateX,
  createStylusSessionModel,
  screenToCanvasPoint,
  scrollYAfterScaleAboutFocal,
  shouldLockNotebookScroll,
} from '../lib/notebookViewport.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

check('clampNotebookScale respects min/max and rejects NaN', () => {
  assert.equal(clampNotebookScale(0.1), NOTEBOOK_MIN_SCALE);
  assert.equal(clampNotebookScale(9), NOTEBOOK_MAX_SCALE);
  assert.equal(clampNotebookScale(1.5), 1.5);
  assert.equal(clampNotebookScale(Number.NaN), NOTEBOOK_DEFAULT_SCALE);
});

check('screenToCanvasPoint divides by scale and subtracts translateX', () => {
  assert.deepEqual(screenToCanvasPoint(100, 50, 20, 2), { x: 50, y: 35 });
  assert.deepEqual(screenToCanvasPoint(10, 10, 0, 0.5), { x: 20, y: 20 });
  assert.deepEqual(screenToCanvasPoint(100, 50, 0, 2, -40), { x: 70, y: 25 });
});

check('scrollYAfterScaleAboutFocal keeps focal content fixed', () => {
  const next = scrollYAfterScaleAboutFocal({
    focalY: 100,
    scrollOffsetY: 200,
    oldScale: 1,
    newScale: 2,
  });
  // logicalY = (100+200)/1 = 300; nextScroll = 300*2 - 100 = 500
  assert.equal(next, 500);
});

check('pinch begin saves startScale / startTranslate / focal semantics', () => {
  const start = {
    startScale: 1,
    startTranslateX: 0,
    startScrollY: 0,
    startFocalX: 400,
    startFocalY: 300,
  };
  const mid = applyPinchZoomFromStart({
    ...start,
    focalX: 400,
    focalY: 300,
    gestureScale: 2,
    viewportWidth: 800,
    viewportHeight: 600,
    contentWidth: 800,
    contentHeight: 2000,
  });
  assert.equal(mid.scale, 2);
  // contentX = 400; tx = 400 - 400*2 = -400
  assert.equal(mid.translateX, -400);
});

check('center focal zoom-in keeps content point under focal', () => {
  const vw = 800;
  const startFocalX = 400;
  const start = applyPinchZoomFromStart({
    startScale: 1,
    startTranslateX: 0,
    startScrollY: 100,
    startFocalX,
    startFocalY: 200,
    focalX: startFocalX,
    focalY: 200,
    gestureScale: 2,
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  });
  const contentX = (startFocalX - 0) / 1;
  const screenX = canvasToScreenX(contentX, start.scale, start.translateX);
  assert.ok(Math.abs(screenX - startFocalX) < 0.01);
});

check('right-side focal zoom-in does not drift left', () => {
  const vw = 800;
  const focalX = 700;
  const out = applyPinchZoomFromStart({
    startScale: 1,
    startTranslateX: 0,
    startScrollY: 0,
    startFocalX: focalX,
    startFocalY: 200,
    focalX,
    focalY: 200,
    gestureScale: 2,
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  });
  const contentX = focalX / 1;
  const screenX = canvasToScreenX(contentX, out.scale, out.translateX);
  assert.ok(Math.abs(screenX - focalX) < 0.01, `screenX=${screenX}`);
  // Left-anchor regression would leave translateX=0 and screenX=1400.
  assert.notEqual(out.translateX, 0);
  assert.ok(out.translateX < 0);
});

check('bottom-right focal keeps both axes', () => {
  const vw = 800;
  const vh = 600;
  const focalX = 720;
  const focalY = 500;
  const startScrollY = 80;
  const out = applyPinchZoomFromStart({
    startScale: 1,
    startTranslateX: 0,
    startScrollY,
    startFocalX: focalX,
    startFocalY: focalY,
    focalX,
    focalY,
    gestureScale: 1.8,
    viewportWidth: vw,
    viewportHeight: vh,
    contentWidth: vw,
    contentHeight: 3000,
  });
  const contentX = focalX;
  const contentY = (focalY + startScrollY) / 1;
  assert.ok(Math.abs(canvasToScreenX(contentX, out.scale, out.translateX) - focalX) < 0.01);
  // screenY in viewport = contentY * scale - scrollY ≈ focalY
  const screenY = contentY * out.scale - out.scrollY;
  assert.ok(Math.abs(screenY - focalY) < 0.01, `screenY=${screenY}`);
});

check('pinch-out about focal keeps content point', () => {
  const vw = 800;
  // Start already zoomed with a pan.
  const startScale = 2;
  const startTx = -400;
  const focalX = 400;
  const out = applyPinchZoomFromStart({
    startScale,
    startTranslateX: startTx,
    startScrollY: 200,
    startFocalX: focalX,
    startFocalY: 150,
    focalX,
    focalY: 150,
    gestureScale: 0.5, // back toward 1x
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  });
  assert.equal(out.scale, 1);
  const contentX = (focalX - startTx) / startScale;
  assert.ok(Math.abs(canvasToScreenX(contentX, out.scale, out.translateX) - focalX) < 0.01);
});

check('repeated update from start does not accumulate error', () => {
  const vw = 800;
  const base = {
    startScale: 1,
    startTranslateX: 0,
    startScrollY: 0,
    startFocalX: 350,
    startFocalY: 220,
    focalX: 350,
    focalY: 220,
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  };
  const a = applyPinchZoomFromStart({ ...base, gestureScale: 1.25 });
  const b = applyPinchZoomFromStart({ ...base, gestureScale: 1.5 });
  const c = applyPinchZoomFromStart({ ...base, gestureScale: 2 });
  // Direct jump to 2x equals stepwise target (begin-relative, not incremental).
  assert.equal(c.scale, 2);
  assert.equal(c.translateX, applyPinchZoomFromStart({ ...base, gestureScale: 2 }).translateX);
  assert.ok(a.translateX !== b.translateX);
});

check('scale clamp at min/max', () => {
  const vw = 800;
  const hi = applyPinchZoomFromStart({
    startScale: 3,
    startTranslateX: 0,
    startScrollY: 0,
    startFocalX: 400,
    startFocalY: 200,
    focalX: 400,
    focalY: 200,
    gestureScale: 4,
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  });
  assert.equal(hi.scale, NOTEBOOK_MAX_SCALE);
  const lo = applyPinchZoomFromStart({
    startScale: 0.6,
    startTranslateX: 0,
    startScrollY: 0,
    startFocalX: 400,
    startFocalY: 200,
    focalX: 400,
    focalY: 200,
    gestureScale: 0.1,
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  });
  assert.equal(lo.scale, NOTEBOOK_MIN_SCALE);
});

check('small content horizontal centering', () => {
  const vw = 800;
  const tx = clampNotebookTranslateX({
    translateX: -100,
    scale: 0.5,
    viewportWidth: vw,
    contentWidth: vw,
  });
  // scaledW = 400; center = (800-400)/2 = 200
  assert.equal(tx, 200);
  const zoomedOut = applyPinchZoomFromStart({
    startScale: 1,
    startTranslateX: 0,
    startScrollY: 0,
    startFocalX: 400,
    startFocalY: 200,
    focalX: 400,
    focalY: 200,
    gestureScale: 0.5,
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  });
  assert.equal(zoomedOut.scale, 0.5);
  assert.equal(zoomedOut.translateX, 200);
});

check('large content boundary clamp', () => {
  const vw = 800;
  const tx = clampNotebookTranslateX({
    translateX: 50, // invalid positive when zoomed in
    scale: 2,
    viewportWidth: vw,
    contentWidth: vw,
  });
  assert.equal(tx, 0);
  const tx2 = clampNotebookTranslateX({
    translateX: -5000,
    scale: 2,
    viewportWidth: vw,
    contentWidth: vw,
  });
  assert.equal(tx2, vw - vw * 2); // -800
});

check('transform round-trip canvas → screen → canvas', () => {
  const scale = 2;
  const tx = -300;
  const scrollY = 120;
  const content = { x: 180, y: 90 };
  const screenX = canvasToScreenX(content.x, scale, tx);
  const screenY = content.y * scale - scrollY; // viewport-local y before adding scroll back
  const back = screenToCanvasPoint(screenX, screenY, scrollY, scale, tx);
  assert.ok(Math.abs(back.x - content.x) < 1e-9);
  assert.ok(Math.abs(back.y - content.y) < 1e-9);
});

check('zoom-in then zoom-out returns near start', () => {
  const vw = 800;
  const start = {
    startScale: 1,
    startTranslateX: 0,
    startScrollY: 40,
    startFocalX: 400,
    startFocalY: 240,
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  };
  const zoomed = applyPinchZoomFromStart({
    ...start,
    focalX: 400,
    focalY: 240,
    gestureScale: 2,
  });
  const back = applyPinchZoomFromStart({
    startScale: zoomed.scale,
    startTranslateX: zoomed.translateX,
    startScrollY: zoomed.scrollY,
    startFocalX: 400,
    startFocalY: 240,
    focalX: 400,
    focalY: 240,
    gestureScale: 0.5,
    viewportWidth: vw,
    viewportHeight: 600,
    contentWidth: vw,
    contentHeight: 2000,
  });
  assert.equal(back.scale, 1);
  assert.ok(Math.abs(back.translateX - 0) < 0.01);
  assert.ok(Math.abs(back.scrollY - 40) < 0.01);
});

check('no NaN / Infinity from bad inputs', () => {
  const out = applyPinchZoomFromStart({
    startScale: Number.NaN,
    startTranslateX: Number.POSITIVE_INFINITY,
    startScrollY: Number.NaN,
    startFocalX: 100,
    startFocalY: 100,
    focalX: 100,
    focalY: 100,
    gestureScale: Number.NaN,
    viewportWidth: 800,
    viewportHeight: 600,
    contentWidth: 800,
    contentHeight: 2000,
  });
  assert.equal(Number.isFinite(out.scale), true);
  assert.equal(Number.isFinite(out.translateX), true);
  assert.equal(Number.isFinite(out.scrollY), true);
});

check('clampNotebookScrollY centers short content at 0', () => {
  assert.equal(
    clampNotebookScrollY({
      scrollY: 50,
      scale: 0.5,
      viewportHeight: 600,
      contentHeight: 400,
    }),
    0,
  );
});

check('stylus down locks scroll synchronously in model', () => {
  const m = createStylusSessionModel(100);
  const s = m.stylusDown();
  assert.equal(s.strokeActive, true);
  assert.equal(s.scrollLocked, true);
});

check('stylus active palm grace keeps lock after up', () => {
  const m = createStylusSessionModel(100);
  m.stylusDown();
  const up = m.stylusUp();
  assert.equal(up.strokeActive, false);
  assert.equal(up.palmGrace, true);
  assert.equal(up.scrollLocked, true);
  const mid = m.tick(50);
  assert.equal(mid.scrollLocked, true);
  const done = m.tick(50);
  assert.equal(done.palmGrace, false);
  assert.equal(done.scrollLocked, false);
});

check('cancel releases lock without grace', () => {
  const m = createStylusSessionModel();
  m.stylusDown();
  const c = m.cancel();
  assert.equal(c.scrollLocked, false);
});

check('pinch rejected while stylus/grace active', () => {
  const m = createStylusSessionModel();
  m.stylusDown();
  const p = m.pinchBegin();
  assert.equal(p.pinchActive, false);
  m.stylusUp();
  const duringGrace = m.pinchBegin();
  assert.equal(duringGrace.pinchActive, false);
});

check('finger-only pinch can activate when idle', () => {
  const m = createStylusSessionModel();
  const p = m.pinchBegin();
  assert.equal(p.pinchActive, true);
  assert.equal(p.scrollLocked, true);
  const end = m.pinchEnd();
  assert.equal(end.pinchActive, false);
  assert.equal(end.scrollLocked, false);
});

check('shouldLockNotebookScroll matrix', () => {
  assert.equal(
    shouldLockNotebookScroll({
      strokeActive: false,
      palmGrace: false,
      pinchActive: false,
      imageManipulation: false,
    }),
    false,
  );
  assert.equal(
    shouldLockNotebookScroll({
      strokeActive: true,
      palmGrace: false,
      pinchActive: false,
      imageManipulation: false,
    }),
    true,
  );
});

check('NotebookCanvas wires focal zoom + sync scroll lock + no debug overlay', () => {
  const canvasPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'components',
    'NotebookCanvas.tsx',
  );
  const source = fs.readFileSync(canvasPath, 'utf8');
  assert.match(source, /beginStylusScrollLock/);
  assert.match(source, /setNativeProps\(\{\s*scrollEnabled/);
  assert.match(source, /NOTEBOOK_PALM_GRACE_MS/);
  assert.match(source, /Gesture\.Pinch\(\)/);
  assert.match(source, /notebookGestures/);
  assert.match(source, /screenToCanvasPoint/);
  assert.match(source, /applyPinchZoomFromStart/);
  assert.match(source, /canvasTranslateX/);
  assert.match(source, /pinchStartFocalXRef/);
  assert.match(source, /translateX:\s*canvasTranslateX/);
  assert.equal(source.includes('pointerDebug'), false);
  assert.equal(source.includes('WRITE ·'), false);
  assert.equal(source.includes('void revision'), false);
  assert.match(source, /setLivePoints/);
  assert.equal(NOTEBOOK_PALM_GRACE_MS, 300);
});

console.log(`\nnotebook-viewport: ${passed} checks passed`);
