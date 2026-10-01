import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createMaterialAnnotationPersistence,
  stringifyJsonArrayCooperatively,
} from '../lib/materialAnnotationPersistence.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('large annotation arrays keep the exact JSON schema and yield between bounded slices', async () => {
  const records = Array.from({ length: 40 }, (_, page) => ({
    pageNumber: page + 1,
    strokes: [{ id: `stroke-${page}`, points: Array.from({ length: 50 }, (_, x) => ({ x, y: page })) }],
  }));
  let clock = 0;
  let yields = 0;

  const encoded = await stringifyJsonArrayCooperatively(records, {
    sliceMs: 8,
    now: () => (clock += 5),
    yieldToEventLoop: async () => { yields += 1; },
  });

  assert.equal(encoded, JSON.stringify(records));
  assert.ok(yields >= 10, `expected frequent event-loop yields, received ${yields}`);
});

test('rapid stroke snapshots do no synchronous serialization and coalesce to the latest durable value', async () => {
  const writes = [];
  const serialized = [];
  const timers = [];
  const persistence = createMaterialAnnotationPersistence({
    write: async (key, json) => { writes.push([key, json]); },
    serialize: async (values) => {
      serialized.push(values);
      return JSON.stringify(values);
    },
    setTimer: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });

  for (let strokeCount = 1; strokeCount <= 6; strokeCount += 1) {
    persistence.schedule('annotations', [{ strokes: Array.from({ length: strokeCount }) }]);
  }

  assert.equal(serialized.length, 0, 'schedule must not stringify on the interaction-critical path');
  assert.equal(writes.length, 0, 'schedule must not write on the interaction-critical path');
  assert.equal(timers.length, 1, 'rapid strokes must not keep postponing the durable checkpoint deadline');
  assert.equal(timers[0].cleared, false);

  await persistence.flush();
  assert.equal(serialized.length, 1);
  assert.deepEqual(JSON.parse(writes[0][1]), [{ strokes: Array.from({ length: 6 }, () => null) }]);
});

test('a flush writes an in-flight checkpoint and then the latest snapshot', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const serialized = [];
  const writes = [];
  const persistence = createMaterialAnnotationPersistence({
    write: async (_key, json) => { writes.push(JSON.parse(json)); },
    serialize: async (values) => {
      serialized.push(values);
      if (serialized.length === 1) await firstGate;
      return JSON.stringify(values);
    },
  });

  persistence.schedule('annotations', [{ id: 'old' }]);
  const flushing = persistence.flush();
  await Promise.resolve();
  assert.equal(serialized.length, 1);

  persistence.schedule('annotations', [{ id: 'latest' }]);
  releaseFirst();
  await flushing;

  assert.equal(serialized.length, 2);
  assert.deepEqual(writes, [[{ id: 'old' }], [{ id: 'latest' }]]);
  assert.equal(persistence.hasPending(), false);
});

test('Course Material flushes latest annotations at background, unmount, and beforeRemove', () => {
  const screen = read('../app/lecture-material/[lectureId]/[materialId].tsx');
  assert.match(screen, /state === 'active' \|\| !useNativePdfViewer\) return;[\s\S]*flushMaterialAnnotations\(\)/);
  assert.match(screen, /persistAuthoritativeViewport\(nativePdf\);\s*void flushMaterialAnnotations\(\)/);
  assert.match(screen, /flushViewportToStore\(\);\s*await flushMaterialAnnotations\(\);\s*leavePersistenceCompletedRef/);
});

test('tool mode uses a native command and is not a live heavy-view prop', () => {
  const screen = read('../app/lecture-material/[lectureId]/[materialId].tsx');
  const wrapper = read('../components/NativePdfAnnotationView.tsx');
  const nativeModule = read('../modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');

  assert.match(screen, /pdfRef\.current\?\.setAnnotationMode\(next\);\s*setNativeAnnotationMode\(next\);/);
  assert.doesNotMatch(screen, /annotationMode=\{nativeAnnotationMode\}/);
  assert.doesNotMatch(screen, /on(?:LoadComplete|PageChanged|Error)=\{\(event\) =>/);
  assert.match(wrapper, /memo\(forwardRef/);
  assert.match(wrapper, /setAnnotationModeAsync\?\.\(mode\)/);
  assert.match(nativeModule, /AsyncFunction\("setAnnotationModeAsync"\)[\s\S]*view\.annotationMode = mode/);
});

test('whole-scope JSON.stringify is absent from the annotation state effect', () => {
  const store = read('../lib/store.tsx');
  const start = store.indexOf("materialAnnotationPersistence.schedule(\n        scopedMaterialAnnotationsKey(storageScopeId)");
  const end = store.indexOf('const createCourse', start);
  const persistenceBlock = store.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(persistenceBlock, /JSON\.stringify\(materialAnnotations\)/);
  assert.match(persistenceBlock, /materialAnnotationPersistence\.schedule/);
  assert.match(store, /const flushMaterialAnnotations = \(\) => materialAnnotationPersistence\.flush\(\)/);
});
