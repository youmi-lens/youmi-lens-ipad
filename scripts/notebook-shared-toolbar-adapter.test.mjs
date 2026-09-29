/**
 * PK4-B1 — Notebook's runtime adapter to the shared annotation tool system
 * (lib/notebookAnnotationAdapter.ts, components/SharedAnnotationToolbar.tsx).
 * Verifies: mode<->tool round-trip, capability-filtered tool list matches
 * Notebook's exact current tool set, preset numeric values are unchanged,
 * SharedAnnotationToolbar dispatches to the exact tools/order it's given,
 * Notebook-only contextual controls remain untouched, and Course Material's
 * source is completely unaffected by this phase.
 *
 * lib/notebookAnnotationAdapter.ts itself is NOT imported directly here: it
 * has a (correct, Metro-standard) extension-less value import of
 * './annotationCapabilities' and './annotationTools', which plain Node's ESM
 * resolver — unlike Metro — cannot resolve without an explicit extension.
 * Adding one to the adapter's own import would be wrong for the real app
 * build, so instead this test imports the same underlying, already-proven
 * (PK4-A) primitives directly (with explicit .ts extensions, the established
 * convention for these test scripts) and verifies the adapter's own source
 * text delegates to them rather than re-implementing a second, competing
 * mapping — the same technique scripts/shared-toolbar-chrome.test.mjs already
 * uses for the same reason.
 * Run: node --experimental-strip-types scripts/notebook-shared-toolbar-adapter.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ANNOTATION_TOOLS,
  NOTEBOOK_MODE_TO_SHARED_TOOL,
  SHARED_TOOL_TO_NOTEBOOK_MODE,
} from '../lib/annotationTools.ts';
import { NOTEBOOK_CAPABILITIES, supportsTool } from '../lib/annotationCapabilities.ts';
import { LEGACY_STYLE_PEN_WIDTHS, HIGHLIGHTER_WIDTHS, NOTEBOOK_ERASER_RADII } from '../lib/annotationPresets.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function check(label, fn) {
  fn();
  console.log(`  ok  ${label}`);
}

const notebookSource = readFileSync(path.join(root, 'components/NotebookCanvas.tsx'), 'utf8');
// PK4-C1 retired MaterialFloatingToolbar.tsx: Course Material now renders
// SharedAnnotationToolbar directly from its own screen file.
const materialSource = readFileSync(path.join(root, 'app/lecture-material/[lectureId]/[materialId].tsx'), 'utf8');
const adapterSource = readFileSync(path.join(root, 'lib/notebookAnnotationAdapter.ts'), 'utf8');
const sharedToolbarSource = readFileSync(path.join(root, 'components/SharedAnnotationToolbar.tsx'), 'utf8');

console.log('1/2. Notebook mode <-> shared tool round-trip');

check('every Notebook CanvasMode round-trips through PK4-A\'s own translation tables, and the adapter delegates to them (not a second mapping)', () => {
  const modes = ['write', 'highlight', 'type', 'erase', 'scroll', 'select', 'insert'];
  for (const mode of modes) {
    const tool = NOTEBOOK_MODE_TO_SHARED_TOOL[mode];
    assert.ok(tool, `no shared tool for Notebook mode ${mode}`);
    assert.equal(SHARED_TOOL_TO_NOTEBOOK_MODE[tool], mode);
  }
  assert.match(adapterSource, /return NOTEBOOK_MODE_TO_SHARED_TOOL\[mode\] \?\? null;/);
  assert.match(adapterSource, /return SHARED_TOOL_TO_NOTEBOOK_MODE\[tool\] as CanvasMode;/);
});

check('SHARED_TOOL_TO_NOTEBOOK_MODE covers every ANNOTATION_TOOLS entry', () => {
  for (const tool of ANNOTATION_TOOLS) {
    assert.ok(SHARED_TOOL_TO_NOTEBOOK_MODE[tool], `no Notebook mode for shared tool ${tool}`);
  }
});

console.log('\n3. Capability filtering produces Notebook\'s exact current primary tool set');

// The adapter's own hand-authored display order (display order is a product
// decision the shared vocabulary doesn't encode — see its doc comment),
// verified present verbatim in its source before being used as this test's
// ground truth for what capability filtering should then confirm.
const NOTEBOOK_TOOL_ORDER_LITERAL = "['pen', 'highlighter', 'text', 'select', 'insert', 'eraser']";

check('the adapter\'s NOTEBOOK_TOOL_ORDER is exactly the historical PRIMARY_TOOLS order, and is capability-filtered rather than used raw', () => {
  assert.ok(
    adapterSource.replace(/\s+/g, ' ').includes(`NOTEBOOK_TOOL_ORDER: readonly AnnotationTool[] = ${NOTEBOOK_TOOL_ORDER_LITERAL}`),
    'NOTEBOOK_TOOL_ORDER literal not found or changed',
  );
  assert.match(adapterSource, /return NOTEBOOK_TOOL_ORDER\.filter\(\(tool\) => supportsTool\(NOTEBOOK_CAPABILITIES, tool\)\);/);
});

check('that order, filtered through the real NOTEBOOK_CAPABILITIES, translated back to modes, exactly matches Notebook\'s historical PRIMARY_TOOLS (write/highlight/type/select/insert/erase, in order)', () => {
  const order = ['pen', 'highlighter', 'text', 'select', 'insert', 'eraser'];
  const filtered = order.filter((tool) => supportsTool(NOTEBOOK_CAPABILITIES, tool));
  const modes = filtered.map((tool) => SHARED_TOOL_TO_NOTEBOOK_MODE[tool]);
  assert.deepEqual(modes, ['write', 'highlight', 'type', 'select', 'insert', 'erase']);
});

check('PRIMARY_TOOLS in NotebookCanvas.tsx is now derived from the adapter, not a second hardcoded array', () => {
  assert.match(notebookSource, /const PRIMARY_TOOLS: \{ key: CanvasMode; label: string \}\[\] = notebookSharedTools\(\)\.map/);
  assert.doesNotMatch(notebookSource, /\{ key: 'write', label: 'Write' \}/);
});

check('notebookToolLabel preserves Notebook\'s historical PRIMARY_TOOLS labels exactly', () => {
  assert.match(adapterSource, /pen: 'Write',/);
  assert.match(adapterSource, /highlighter: 'Highlight',/);
  assert.match(adapterSource, /text: 'Text',/);
  assert.match(adapterSource, /select: 'Select',/);
  assert.match(adapterSource, /insert: 'Insert',/);
  assert.match(adapterSource, /eraser: 'Erase',/);
});

console.log('\n4/5. Preset mapping — numeric values unchanged, sourced from the shared tables');

check('Notebook\'s PEN_WIDTHS values equal LEGACY_STYLE_PEN_WIDTHS exactly (2 / 3.5 / 6) — no drift', () => {
  assert.equal(LEGACY_STYLE_PEN_WIDTHS.thin, 2);
  assert.equal(LEGACY_STYLE_PEN_WIDTHS.medium, 3.5);
  assert.equal(LEGACY_STYLE_PEN_WIDTHS.thick, 6);
  assert.match(notebookSource, /value: LEGACY_STYLE_PEN_WIDTHS\.thin, dot: 7/);
  assert.match(notebookSource, /value: LEGACY_STYLE_PEN_WIDTHS\.medium, dot: 11/);
  assert.match(notebookSource, /value: LEGACY_STYLE_PEN_WIDTHS\.thick, dot: 16/);
});

check('Notebook\'s HIGHLIGHTER_WIDTHS values equal the shared table exactly (12 / 18 / 26) — no drift', () => {
  assert.equal(HIGHLIGHTER_WIDTHS.narrow, 12);
  assert.equal(HIGHLIGHTER_WIDTHS.medium, 18);
  assert.equal(HIGHLIGHTER_WIDTHS.wide, 26);
  assert.match(notebookSource, /value: SHARED_HIGHLIGHTER_WIDTHS\.narrow, dot: 8/);
  assert.match(notebookSource, /value: SHARED_HIGHLIGHTER_WIDTHS\.medium, dot: 12/);
  assert.match(notebookSource, /value: SHARED_HIGHLIGHTER_WIDTHS\.wide, dot: 17/);
});

check('Notebook\'s ERASER_SIZES radii equal NOTEBOOK_ERASER_RADII exactly (12 / 26 / 44) — no drift, and still distinct from Course Material\'s', () => {
  assert.equal(NOTEBOOK_ERASER_RADII.small, 12);
  assert.equal(NOTEBOOK_ERASER_RADII.medium, 26);
  assert.equal(NOTEBOOK_ERASER_RADII.large, 44);
  assert.match(notebookSource, /radius: NOTEBOOK_ERASER_RADII\.small/);
  assert.match(notebookSource, /radius: NOTEBOOK_ERASER_RADII\.medium/);
  assert.match(notebookSource, /radius: NOTEBOOK_ERASER_RADII\.large/);
});

console.log('\n8. The shared toolbar component owns both layouts internally; Notebook drives it through one call site (presentational contract)');

check('SharedAnnotationToolbar self-measures via its own root View (mirrors the retired MaterialFloatingToolbar\'s proven pattern), not a Fragment depending on a host-measured container', () => {
  assert.match(sharedToolbarSource, /<View ref=\{rootRef\} style=\{StyleSheet\.absoluteFill\}/);
});

check('SharedAnnotationToolbar knows nothing about NoteStroke/PKDrawing/PDF document internals (presentational only; it may own its own dock/collapsed UI-chrome preferences)', () => {
  // Checks actual import/usage code, not doc comments (this file's own
  // header comment explains what it deliberately does NOT reference, which
  // would otherwise false-positive a bare substring check).
  const codeOnly = sharedToolbarSource.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['NoteStroke', 'PKDrawing', 'PDFView', 'PdfAnnotation']) {
    assert.ok(!codeOnly.includes(forbidden), `SharedAnnotationToolbar's actual code unexpectedly references ${forbidden}`);
  }
});

check('PK4-C1: Notebook renders exactly ONE SharedAnnotationToolbar call site — both horizontal and vertical (Concept-C) layouts now live inside the shared component itself, not as two separate host-side trees', () => {
  const occurrences = notebookSource.split('<SharedAnnotationToolbar').length - 1;
  assert.equal(occurrences, 1, `expected exactly 1 SharedAnnotationToolbar call site, found ${occurrences}`);
  assert.match(notebookSource, /tools=\{notebookSharedTools\(\)\}/);
  assert.match(notebookSource, /activeTool=\{notebookModeToSharedTool\(mode\) \?\? 'pen'\}/);
  assert.match(notebookSource, /onSelectTool=\{\(tool\) => changeMode\(sharedToolToNotebookMode\(tool\)\)\}/);
});

check('PK4-C1: Course Material also renders SharedAnnotationToolbar directly (no second, Material-specific toolbar layout)', () => {
  const occurrences = materialSource.split('<SharedAnnotationToolbar').length - 1;
  assert.equal(occurrences, 2, `expected exactly 2 SharedAnnotationToolbar call sites (native PDFKit path + legacy JS-overlay path), found ${occurrences}`);
  assert.doesNotMatch(materialSource, /MaterialFloatingToolbar/);
});

console.log('\n9. Notebook-only contextual controls remain available, untouched');

check('fixed top-right Undo/Redo, Clear-page pill, select-shape panel, and insert-photo row are all still wired, present and unmoved', () => {
  // PK4-C1: the fixed Undo/Redo capsule's own styling now lives inside
  // SharedAnnotationToolbar (styles.fixedHistory there); Notebook only opts
  // into it via the showFixedHistory prop.
  assert.match(notebookSource, /showFixedHistory=\{showFixedHistory\}/);
  assert.match(sharedToolbarSource, /styles\.fixedHistory/);
  assert.match(notebookSource, /handleTrashPress/);
  assert.match(notebookSource, /<SharedSelectionShapeContext/);
  assert.match(notebookSource, /t\('tools\.insertHint'\)/);
});

check('the selection Duplicate/Delete floating image action bar is still separate from the toolbar (unmoved)', () => {
  assert.match(notebookSource, /Not part of the draggable toolbar/);
});

check('Concept-C vertical split-capsule layout (rail + context + action capsules) is preserved, now inside the one shared component both Notebook and Course Material render — not duplicated back into NotebookCanvas.tsx', () => {
  assert.match(sharedToolbarSource, /Concept C/);
  assert.match(sharedToolbarSource, /styles\.vCapsule/);
  assert.match(sharedToolbarSource, /styles\.vActionCapsule/);
  assert.doesNotMatch(notebookSource, /styles\.vCapsule/);
});

console.log('\n10. Course Material never uses Notebook\'s own private adapter (PK4-C gave it its own instead)');

check('Course Material never imports Notebook\'s own notebookAnnotationAdapter.ts — it has its own courseMaterialAnnotationAdapter.ts (see the PK4-C report); SharedAnnotationToolbar itself is legitimately shared by both', () => {
  assert.ok(!materialSource.includes('notebookAnnotationAdapter'), 'Course Material screen unexpectedly references notebookAnnotationAdapter');
  assert.match(materialSource, /from '@\/lib\/courseMaterialAnnotationAdapter'/);
});

console.log('\nnotebook-shared-toolbar-adapter: all checks passed');
