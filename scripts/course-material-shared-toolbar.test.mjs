/**
 * PK4-C — Course Material's runtime adapter to the shared annotation tool
 * system (lib/courseMaterialAnnotationAdapter.ts). Mirrors scripts/
 * notebook-shared-toolbar-adapter.test.mjs exactly, for Course Material.
 * Verifies: mode<->tool round-trip, capability-filtered tool list matches
 * Course Material's exact current tool set (no fake Select/Insert parity),
 * text gate correctness, preset numeric values are unchanged, both
 * workspaces now consume the one real shared toolbar component, PDF native
 * files are untouched, and Notebook's PK4-B1 behavior is unaffected.
 *
 * lib/courseMaterialAnnotationAdapter.ts itself is NOT imported directly
 * here, for the same reason notebookAnnotationAdapter.ts isn't in PK4-B1's
 * test: it has a (correct, Metro-standard) extension-less value import of
 * './annotationCapabilities'/'./annotationTools' that plain Node's ESM
 * resolver can't resolve without an explicit extension. Instead this test
 * imports the same underlying, already-proven (PK4-A) primitives directly
 * (with explicit .ts extensions) and verifies the adapter's own source text
 * delegates to them.
 * Run: node --experimental-strip-types scripts/course-material-shared-toolbar.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  MATERIAL_MODE_TO_SHARED_TOOL,
  SHARED_TOOL_TO_MATERIAL_MODE,
} from '../lib/annotationTools.ts';
import { courseMaterialCapabilities, supportsTool } from '../lib/annotationCapabilities.ts';
import { LEGACY_STYLE_PEN_WIDTHS, HIGHLIGHTER_WIDTHS, COURSE_MATERIAL_ERASER_RADII } from '../lib/annotationPresets.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function check(label, fn) {
  fn();
  console.log(`  ok  ${label}`);
}

const notebookSource = readFileSync(path.join(root, 'components/NotebookCanvas.tsx'), 'utf8');
const materialScreenSource = readFileSync(
  path.join(root, 'app/lecture-material/[lectureId]/[materialId].tsx'),
  'utf8',
);
const adapterSource = readFileSync(path.join(root, 'lib/courseMaterialAnnotationAdapter.ts'), 'utf8');
const sharedToolbarSource = readFileSync(path.join(root, 'components/SharedAnnotationToolbar.tsx'), 'utf8');
const pdfAnnotationViewSource = readFileSync(
  path.join(root, 'modules/expo-pdf-annotation/ios/PdfAnnotationView.swift'),
  'utf8',
);

console.log('1. Both Notebook and Course Material consume the exact same shared toolbar component');

check('PK4-C1: SharedAnnotationToolbar is rendered directly by both the Course Material screen and NotebookCanvas.tsx — there is no second, Material-specific toolbar component any more', () => {
  assert.match(materialScreenSource, /<SharedAnnotationToolbar\b/);
  assert.match(notebookSource, /<SharedAnnotationToolbar\b/);
  assert.doesNotMatch(materialScreenSource, /MaterialFloatingToolbar/);
});

console.log('\n2. Course Material tool IDs use the shared AnnotationTool vocabulary');

check('MaterialToolMode <-> AnnotationTool round-trips through PK4-A\'s own translation tables, and the adapter delegates to them (not a second mapping)', () => {
  for (const mode of ['scroll', 'pen', 'highlighter', 'eraser', 'text', 'select']) {
    const tool = MATERIAL_MODE_TO_SHARED_TOOL[mode];
    assert.ok(tool, `no shared tool for Material mode ${mode}`);
    assert.equal(SHARED_TOOL_TO_MATERIAL_MODE[tool], mode);
  }
  assert.match(adapterSource, /return MATERIAL_MODE_TO_SHARED_TOOL\[mode\] \?\? null;/);
  assert.match(adapterSource, /return SHARED_TOOL_TO_MATERIAL_MODE\[tool\] as MaterialToolMode;/);
});

console.log('\n3. Course Material capability filtering is correct');

const MATERIAL_TOOL_ORDER_LITERAL = "['pen', 'highlighter', 'text', 'select', 'eraser']";

check('the adapter\'s MATERIAL_TOOL_ORDER is capability-filtered rather than used raw', () => {
  assert.ok(
    adapterSource.replace(/\s+/g, ' ').includes(`MATERIAL_TOOL_ORDER: readonly AnnotationTool[] = ${MATERIAL_TOOL_ORDER_LITERAL}`),
    'MATERIAL_TOOL_ORDER literal not found or changed',
  );
  assert.match(adapterSource, /return MATERIAL_TOOL_ORDER\.filter\(\(tool\) => supportsTool\(capabilities, tool\)\);/);
});

check('native-path capabilities follow Notebook\'s relative Pen/Highlighter/Text/Select/Eraser order', () => {
  const native = courseMaterialCapabilities({ usingNativePdfViewer: true });
  const order = ['pen', 'highlighter', 'text', 'select', 'eraser'];
  const filtered = order.filter((tool) => supportsTool(native, tool));
  assert.deepEqual(filtered, ['pen', 'highlighter', 'text', 'select', 'eraser']);
});

console.log('\n4. Select is native-only; Insert remains absent');

check('Select is exposed only with the native PDF viewer, while Insert remains absent', () => {
  assert.match(adapterSource.replace(/\s+/g, ' '), /MATERIAL_TOOL_ORDER: readonly AnnotationTool\[\] = \[[^\]]*'select'/);
  assert.doesNotMatch(adapterSource.replace(/\s+/g, ' '), /MATERIAL_TOOL_ORDER: readonly AnnotationTool\[\] = \[[^\]]*'insert'/);
  for (const usingNativePdfViewer of [true, false]) {
    const caps = courseMaterialCapabilities({ usingNativePdfViewer });
    assert.equal(supportsTool(caps, 'select'), usingNativePdfViewer);
    assert.equal(supportsTool(caps, 'insert'), false);
  }
  assert.match(materialScreenSource, /<SharedSelectionShapeContext/);
  assert.match(materialScreenSource, /onSelectionChanged=\{handleNativeSelectionChanged\}/);
});

console.log('\n5. Text gate remains correct');

check('legacy JS-overlay path (usingNativePdfViewer: false) excludes text; native path includes it', () => {
  const legacy = courseMaterialCapabilities({ usingNativePdfViewer: false });
  const native = courseMaterialCapabilities({ usingNativePdfViewer: true });
  assert.equal(supportsTool(legacy, 'text'), false);
  assert.equal(supportsTool(native, 'text'), true);
  // PK4-C1: each call site derives its tool list from the real runtime
  // branch it's in (native PDFKit vs legacy JS-overlay) — not a showTextTool
  // flag passed down into a Material-specific toolbar component (retired).
  assert.match(
    materialScreenSource,
    /courseMaterialSharedTools\(courseMaterialCapabilities\(\{ usingNativePdfViewer: true \}\)\)/,
  );
  assert.match(
    materialScreenSource,
    /courseMaterialSharedTools\(courseMaterialCapabilities\(\{ usingNativePdfViewer: false \}\)\)/,
  );
});

console.log('\n6/7/8. Preset mapping — numeric values unchanged, sourced from the shared tables, still distinct from Notebook\'s eraser');

check('Course Material\'s PEN_WIDTHS equal LEGACY_STYLE_PEN_WIDTHS exactly (2 / 3.5 / 6) — no drift', () => {
  assert.equal(LEGACY_STYLE_PEN_WIDTHS.thin, 2);
  assert.equal(LEGACY_STYLE_PEN_WIDTHS.medium, 3.5);
  assert.equal(LEGACY_STYLE_PEN_WIDTHS.thick, 6);
  assert.match(materialScreenSource, /value: LEGACY_STYLE_PEN_WIDTHS\.thin, dot: 7/);
  assert.match(materialScreenSource, /value: LEGACY_STYLE_PEN_WIDTHS\.medium, dot: 11/);
  assert.match(materialScreenSource, /value: LEGACY_STYLE_PEN_WIDTHS\.thick, dot: 16/);
});

check('Course Material\'s HIGHLIGHTER_WIDTHS equal the shared table exactly (12 / 18 / 26) — no drift', () => {
  assert.equal(HIGHLIGHTER_WIDTHS.narrow, 12);
  assert.equal(HIGHLIGHTER_WIDTHS.medium, 18);
  assert.equal(HIGHLIGHTER_WIDTHS.wide, 26);
  assert.match(materialScreenSource, /value: SHARED_HIGHLIGHTER_WIDTHS\.narrow, dot: 8/);
  assert.match(materialScreenSource, /value: SHARED_HIGHLIGHTER_WIDTHS\.medium, dot: 12/);
  assert.match(materialScreenSource, /value: SHARED_HIGHLIGHTER_WIDTHS\.wide, dot: 17/);
});

check('Course Material\'s ERASER_SIZES equal COURSE_MATERIAL_ERASER_RADII exactly (16 / 26 / 40) — no drift, still distinct from Notebook\'s (12/26/44)', () => {
  assert.equal(COURSE_MATERIAL_ERASER_RADII.small, 16);
  assert.equal(COURSE_MATERIAL_ERASER_RADII.medium, 26);
  assert.equal(COURSE_MATERIAL_ERASER_RADII.large, 40);
  assert.match(materialScreenSource, /value: COURSE_MATERIAL_ERASER_RADII\.small, dot: 8/);
  assert.match(materialScreenSource, /value: COURSE_MATERIAL_ERASER_RADII\.medium, dot: 13/);
  assert.match(materialScreenSource, /value: COURSE_MATERIAL_ERASER_RADII\.large, dot: 19/);
});

console.log('\n9. Undo/Redo dispatch into existing Course Material handlers (unchanged plumbing)');

check('SharedAnnotationToolbarProps still exposes onUndo/canUndo/onRedo/canRedo as direct callbacks, unchanged — history stays adapter/screen-owned, never merged with Notebook\'s', () => {
  assert.match(sharedToolbarSource, /onUndo: \(\) => void;/);
  assert.match(sharedToolbarSource, /canUndo: boolean;/);
  assert.match(sharedToolbarSource, /onRedo: \(\) => void;/);
  assert.match(sharedToolbarSource, /canRedo: boolean;/);
  assert.match(materialScreenSource, /onUndo=\{undoNativeCurrentPage\}/);
  assert.match(materialScreenSource, /onUndo=\{undoCurrentPage\}/);
});

console.log('\n10. Shared common chrome is not duplicated (see shared-toolbar-chrome.test.mjs for the exhaustive version)');

check('PK4-C1: the material screen renders glyphs via SharedToolbarGlyphPaths directly, and NavySurface/GripDots/dock math live only inside the one shared component — nowhere in the material screen itself', () => {
  assert.match(materialScreenSource, /<SharedToolbarGlyphPaths name=\{materialGlyphName\(tool\)\} color=\{color\} \/>/);
  assert.doesNotMatch(materialScreenSource, /NavySurface|ToolbarGripDots|dockAnchorPoint/);
  assert.match(sharedToolbarSource, /<NavySurface/);
  assert.match(sharedToolbarSource, /<ToolbarGripDots \/>/);
  assert.match(sharedToolbarSource, /dockAnchorPoint\(dock, containerSize, footprint\)/);
});

console.log('\n11. PDF native viewer adds selection without taking shared toolbar ownership');

check('PdfAnnotationView.swift owns page-coordinate selection and has no shared-toolbar/adapter references', () => {
  for (const forbidden of ['SharedAnnotationToolbar', 'courseMaterialAnnotationAdapter']) {
    assert.ok(!pdfAnnotationViewSource.includes(forbidden), `PdfAnnotationView.swift unexpectedly references ${forbidden}`);
  }
  assert.match(pdfAnnotationViewSource, /func beginSelection\(at viewPoint: CGPoint/);
});

console.log('\n12. Notebook\'s PK4-B1 behavior remains unchanged');

check('Notebook\'s own adapter and tool order are unchanged; the Concept-C layout it drives lives in the one shared component (see shared-toolbar-chrome.test.mjs)', () => {
  assert.match(notebookSource, /notebookSharedTools\(\)/);
  assert.match(sharedToolbarSource, /styles\.vCapsule/);
  assert.doesNotMatch(notebookSource, /courseMaterialAnnotationAdapter/);
});

console.log('\ncourse-material-shared-toolbar: all checks passed');
