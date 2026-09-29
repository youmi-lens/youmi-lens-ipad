/**
 * PK4-A — shared annotation foundation (tool IDs, semantic presets,
 * capabilities, command interface shape). Pure logic, no rendering. As of
 * PK4-B1/PK4-C/PK4-C1, both NotebookCanvas.tsx and Course Material (the
 * lecture-material screen, via SharedAnnotationToolbar) consume this.
 * Run: node --experimental-strip-types scripts/annotation-shared-foundation.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ANNOTATION_TOOLS,
  SHARED_TOOL_TO_NOTEBOOK_MODE,
  NOTEBOOK_MODE_TO_SHARED_TOOL,
  SHARED_TOOL_TO_MATERIAL_MODE,
  MATERIAL_MODE_TO_SHARED_TOOL,
} from '../lib/annotationTools.ts';
import {
  PEN_PRESETS,
  HIGHLIGHTER_PRESETS,
  ERASER_PRESETS,
  LEGACY_STYLE_PEN_WIDTHS,
  PENCILKIT_PEN_WIDTHS,
  HIGHLIGHTER_WIDTHS,
  NOTEBOOK_ERASER_RADII,
  COURSE_MATERIAL_ERASER_RADII,
} from '../lib/annotationPresets.ts';
import {
  NOTEBOOK_CAPABILITIES,
  courseMaterialCapabilities,
  supportsTool,
} from '../lib/annotationCapabilities.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function check(label, fn) {
  fn();
  console.log(`  ok  ${label}`);
}

console.log('Shared tool identifiers');

check('every shared tool id round-trips through the Notebook mode mapping', () => {
  for (const tool of ANNOTATION_TOOLS) {
    const notebookMode = SHARED_TOOL_TO_NOTEBOOK_MODE[tool];
    assert.ok(notebookMode, `missing Notebook mapping for ${tool}`);
    assert.equal(NOTEBOOK_MODE_TO_SHARED_TOOL[notebookMode], tool);
  }
});

check('Notebook mapping targets match CanvasMode\'s real values, verified against the actual source', () => {
  const source = readFileSync(path.join(root, 'components/NotebookCanvas.tsx'), 'utf8');
  assert.match(source, /export type CanvasMode = 'write' \| 'highlight' \| 'type' \| 'erase' \| 'scroll' \| 'select' \| 'insert';/);
  for (const notebookMode of Object.values(SHARED_TOOL_TO_NOTEBOOK_MODE)) {
    assert.ok(source.includes(`'${notebookMode}'`), `CanvasMode must actually contain '${notebookMode}'`);
  }
});

check('Course Material mapping includes native Select but no Insert', () => {
  assert.equal(SHARED_TOOL_TO_MATERIAL_MODE.select, 'select');
  assert.equal(SHARED_TOOL_TO_MATERIAL_MODE.insert, undefined);
  assert.equal(MATERIAL_MODE_TO_SHARED_TOOL.pen, 'pen');
  assert.equal(MATERIAL_MODE_TO_SHARED_TOOL.highlighter, 'highlighter');
});

check('Material mapping targets match MaterialToolMode\'s real values, verified against the actual source', () => {
  // PK4-C1 retired MaterialFloatingToolbar.tsx (Course Material now renders
  // SharedAnnotationToolbar directly); MaterialToolMode now lives with its
  // only remaining consumer, the adapter itself.
  const source = readFileSync(path.join(root, 'lib/courseMaterialAnnotationAdapter.ts'), 'utf8');
  assert.match(source, /export type MaterialToolMode = 'scroll' \| 'pen' \| 'highlighter' \| 'eraser' \| 'text' \| 'select';/);
  for (const materialMode of Object.values(SHARED_TOOL_TO_MATERIAL_MODE)) {
    assert.ok(source.includes(`'${materialMode}'`), `MaterialToolMode must actually contain '${materialMode}'`);
  }
});

console.log('\nShared semantic presets — numeric values verified against real source, not assumed');

check('PEN_PRESETS/HIGHLIGHTER_PRESETS/ERASER_PRESETS are exactly three tiers each', () => {
  assert.deepEqual(PEN_PRESETS, ['thin', 'medium', 'thick']);
  assert.deepEqual(HIGHLIGHTER_PRESETS, ['narrow', 'medium', 'wide']);
  assert.deepEqual(ERASER_PRESETS, ['small', 'medium', 'large']);
});

const notebookSource = readFileSync(path.join(root, 'components/NotebookCanvas.tsx'), 'utf8');
const materialSource = readFileSync(
  path.join(root, 'app/lecture-material/[lectureId]/[materialId].tsx'),
  'utf8',
);
const pencilKitSource = readFileSync(
  path.join(root, 'modules/expo-pencilkit-test/ios/PencilKitTestModule.swift'),
  'utf8',
);

check('LEGACY_STYLE_PEN_WIDTHS matches Notebook\'s real PEN_WIDTHS exactly', () => {
  // PK4-B1: Notebook now IMPORTS these values from lib/annotationPresets.ts
  // instead of hardcoding a second copy — verify Notebook's PEN_WIDTHS is
  // actually SOURCED from the shared constant (not just coincidentally
  // equal), and that the shared constant itself still holds the exact
  // physically-accepted values.
  assert.match(notebookSource, /LEGACY_STYLE_PEN_WIDTHS[\s\S]*\} from '@\/lib\/annotationPresets';/);
  assert.match(notebookSource, /\{ key: 'Thin', value: LEGACY_STYLE_PEN_WIDTHS\.thin, dot: 7 \}/);
  assert.match(notebookSource, /\{ key: 'Medium', value: LEGACY_STYLE_PEN_WIDTHS\.medium, dot: 11 \}/);
  assert.match(notebookSource, /\{ key: 'Thick', value: LEGACY_STYLE_PEN_WIDTHS\.thick, dot: 16 \}/);
  assert.deepEqual(LEGACY_STYLE_PEN_WIDTHS, { thin: 2, medium: 3.5, thick: 6 });
});

check('LEGACY_STYLE_PEN_WIDTHS also matches Course Material\'s real PEN_WIDTHS exactly (PK4-C: sourced from the shared constant, not re-hardcoded)', () => {
  assert.match(materialSource, /LEGACY_STYLE_PEN_WIDTHS[\s\S]*\} from '@\/lib\/annotationPresets';/);
  assert.match(materialSource, /\{ key: 'Thin', value: LEGACY_STYLE_PEN_WIDTHS\.thin, dot: 7 \}/);
  assert.match(materialSource, /\{ key: 'Medium', value: LEGACY_STYLE_PEN_WIDTHS\.medium, dot: 11 \}/);
  assert.match(materialSource, /\{ key: 'Thick', value: LEGACY_STYLE_PEN_WIDTHS\.thick, dot: 16 \}/);
});

check('PENCILKIT_PEN_WIDTHS matches the real, physically-accepted, frozen PencilKit widthPresets exactly', () => {
  assert.match(pencilKitSource, /"thin": 1\.5, "medium": 2\.68, "thick": 6\.0/);
  assert.deepEqual(PENCILKIT_PEN_WIDTHS, { thin: 1.5, medium: 2.68, thick: 6.0 });
});

check('PENCILKIT_PEN_WIDTHS is NOT the same as LEGACY_STYLE_PEN_WIDTHS — they must never be unified', () => {
  assert.notDeepEqual(PENCILKIT_PEN_WIDTHS, LEGACY_STYLE_PEN_WIDTHS);
});

check('HIGHLIGHTER_WIDTHS matches Course Material\'s real HIGHLIGHTER_WIDTHS exactly (PK4-C: sourced from the shared constant, not re-hardcoded)', () => {
  assert.match(materialSource, /HIGHLIGHTER_WIDTHS as SHARED_HIGHLIGHTER_WIDTHS[\s\S]*\} from '@\/lib\/annotationPresets';/);
  assert.match(materialSource, /\{ key: 'Narrow', value: SHARED_HIGHLIGHTER_WIDTHS\.narrow, dot: 8 \}/);
  assert.match(materialSource, /\{ key: 'Medium', value: SHARED_HIGHLIGHTER_WIDTHS\.medium, dot: 12 \}/);
  assert.match(materialSource, /\{ key: 'Wide', value: SHARED_HIGHLIGHTER_WIDTHS\.wide, dot: 17 \}/);
  assert.deepEqual(HIGHLIGHTER_WIDTHS, { narrow: 12, medium: 18, wide: 26 });
});

check('HIGHLIGHTER_WIDTHS matches Notebook\'s real HIGHLIGHTER_WIDTHS exactly (PK4-B1: sourced from the shared constant, not re-hardcoded)', () => {
  assert.match(notebookSource, /HIGHLIGHTER_WIDTHS as SHARED_HIGHLIGHTER_WIDTHS.*\} from '@\/lib\/annotationPresets';/);
  assert.match(notebookSource, /\{ key: 'Narrow', value: SHARED_HIGHLIGHTER_WIDTHS\.narrow, dot: 8 \}/);
  assert.match(notebookSource, /\{ key: 'Medium', value: SHARED_HIGHLIGHTER_WIDTHS\.medium, dot: 12 \}/);
  assert.match(notebookSource, /\{ key: 'Wide', value: SHARED_HIGHLIGHTER_WIDTHS\.wide, dot: 17 \}/);
});

check('NOTEBOOK_ERASER_RADII matches Notebook\'s real ERASER_SIZES exactly (PK4-B1: sourced from the shared constant, not re-hardcoded)', () => {
  assert.match(notebookSource, /NOTEBOOK_ERASER_RADII.*\} from '@\/lib\/annotationPresets';/);
  assert.match(notebookSource, /\{ key: 'small', label: 'Small', radius: NOTEBOOK_ERASER_RADII\.small \}/);
  assert.match(notebookSource, /\{ key: 'medium', label: 'Medium', radius: NOTEBOOK_ERASER_RADII\.medium \}/);
  assert.match(notebookSource, /\{ key: 'large', label: 'Large', radius: NOTEBOOK_ERASER_RADII\.large \}/);
  assert.deepEqual(NOTEBOOK_ERASER_RADII, { small: 12, medium: 26, large: 44 });
});

check('COURSE_MATERIAL_ERASER_RADII matches Course Material\'s real ERASER_SIZES exactly, and DIFFERS from Notebook\'s (PK4-C: sourced from the shared constant, not re-hardcoded)', () => {
  assert.match(materialSource, /COURSE_MATERIAL_ERASER_RADII[\s\S]*\} from '@\/lib\/annotationPresets';/);
  assert.match(materialSource, /\{ key: 'Small', value: COURSE_MATERIAL_ERASER_RADII\.small, dot: 8 \}/);
  assert.match(materialSource, /\{ key: 'Medium', value: COURSE_MATERIAL_ERASER_RADII\.medium, dot: 13 \}/);
  assert.match(materialSource, /\{ key: 'Large', value: COURSE_MATERIAL_ERASER_RADII\.large, dot: 19 \}/);
  assert.deepEqual(COURSE_MATERIAL_ERASER_RADII, { small: 16, medium: 26, large: 40 });
  assert.notDeepEqual(COURSE_MATERIAL_ERASER_RADII, NOTEBOOK_ERASER_RADII);
});

console.log('\nShared capability model');

check('Notebook supports every shared tool', () => {
  for (const tool of ANNOTATION_TOOLS) {
    assert.equal(supportsTool(NOTEBOOK_CAPABILITIES, tool), true, `Notebook must support ${tool}`);
  }
});

check('Course Material Select is native-only; Insert remains unavailable', () => {
  const native = courseMaterialCapabilities({ usingNativePdfViewer: true });
  const legacy = courseMaterialCapabilities({ usingNativePdfViewer: false });
  assert.equal(supportsTool(native, 'select'), true);
  assert.equal(supportsTool(legacy, 'select'), false);
  for (const caps of [native, legacy]) {
    assert.equal(supportsTool(caps, 'insert'), false);
    assert.equal(supportsTool(caps, 'pen'), true);
    assert.equal(supportsTool(caps, 'highlighter'), true);
    assert.equal(supportsTool(caps, 'eraser'), true);
    assert.equal(supportsTool(caps, 'scroll'), true);
    assert.equal(supportsTool(caps, 'undo' /* not a tool, sanity default-false path */), false);
  }
});

check('Course Material text support is conditional on the native PDFKit path, matching the real runtime gate', () => {
  const native = courseMaterialCapabilities({ usingNativePdfViewer: true });
  const legacy = courseMaterialCapabilities({ usingNativePdfViewer: false });
  assert.equal(supportsTool(native, 'text'), true);
  assert.equal(supportsTool(legacy, 'text'), false);
  // PK4-C1: the gate itself is now the shared tools array
  // (courseMaterialCapabilities({ usingNativePdfViewer }) — text is
  // genuinely absent from `tools` on the legacy path, not merely hidden by a
  // showTextTool flag), verified directly rather than via a comment string.
  assert.match(materialSource, /tools=\{courseMaterialSharedTools\(courseMaterialCapabilities\(\{ usingNativePdfViewer: true \}\)\)\}/);
  assert.match(materialSource, /tools=\{courseMaterialSharedTools\(courseMaterialCapabilities\(\{ usingNativePdfViewer: false \}\)\)\}/);
});

console.log('\nannotation-shared-foundation: all checks passed');
