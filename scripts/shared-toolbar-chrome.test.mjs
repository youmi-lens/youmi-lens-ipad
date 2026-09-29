/**
 * PK4-B0/PK4-B1/PK4-C/PK4-C1 — shared toolbar chrome (lib/sharedToolbarChrome.ts +
 * components/SharedToolbarChrome.tsx). Verifies every extracted value/path
 * against the REAL, current source.
 *
 * As of PK4-C1, the dock/drag math, the navy gradient surface, and the grip
 * dots are no longer duplicated per-workspace at all: both Notebook and
 * Course Material render the ONE components/SharedAnnotationToolbar.tsx
 * component, which is the sole consumer of lib/sharedToolbarChrome.ts and
 * components/SharedToolbarChrome.tsx's NavySurface/ToolbarGripDots. Neither
 * NotebookCanvas.tsx nor the Course Material screen re-implements any of
 * this chrome any more (MaterialFloatingToolbar.tsx, which used to hold
 * Course Material's own copy, was retired by PK4-C1). NotebookCanvas.tsx
 * keeps only its own genuinely Notebook-only glyphs (select/insert/
 * duplicate/trash/more/chevronDown), delegating the 9 shared glyph names to
 * SharedToolbarGlyphPaths; Course Material's screen has zero local-only
 * glyphs left and renders SharedToolbarGlyphPaths directly.
 *
 * Pure logic (tokens, dockAnchorPoint) is imported and executed directly;
 * the JSX half (SharedToolbarChrome.tsx / SharedAnnotationToolbar.tsx)
 * cannot be executed under node's type-stripping (no JSX transform), so it
 * is verified by comparing its own source text instead.
 * Run: node --experimental-strip-types scripts/shared-toolbar-chrome.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  TOOLBAR_NAVY_TOP,
  TOOLBAR_NAVY_BOTTOM,
  TOOLBAR_BORDER_COLOR,
  TOOLBAR_SELECTED,
  TOOLBAR_ICON_IDLE,
  TOOLBAR_ICON_DISABLED,
  TOOLBAR_DIVIDER_COLOR,
  TOOLBAR_SHELL_RADIUS,
  TOOLBAR_MINIMIZED_RADIUS,
  TOOLBAR_CHIP_RADIUS,
  TOOLBAR_EDGE_MARGIN,
  TOOLBAR_DRAG_THRESHOLD,
  TOOLBAR_ICON_HIT_SLOP,
  TOOLBAR_SIDE_EDGE_ZONE_RATIO,
  TOOLBAR_SIDE_EDGE_ZONE_MIN,
  TOOLBAR_VERT_EDGE_ZONE_RATIO,
  TOOLBAR_VERT_EDGE_ZONE_MIN,
  toolbarClamp,
  dockIsVertical,
  dockAnchorPoint,
} from '../lib/sharedToolbarChrome.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function check(label, fn) {
  fn();
  console.log(`  ok  ${label}`);
}

const notebookSource = readFileSync(path.join(root, 'components/NotebookCanvas.tsx'), 'utf8');
const materialSource = readFileSync(path.join(root, 'app/lecture-material/[lectureId]/[materialId].tsx'), 'utf8');
const sharedToolbarSource = readFileSync(path.join(root, 'components/SharedAnnotationToolbar.tsx'), 'utf8');
const sharedJsxSource = readFileSync(path.join(root, 'components/SharedToolbarChrome.tsx'), 'utf8');

const SHARED_TOKEN_NAMES = [
  'TOOLBAR_BORDER_COLOR',
  'TOOLBAR_SELECTED',
  'TOOLBAR_ICON_IDLE',
  'TOOLBAR_ICON_DISABLED',
  'TOOLBAR_DIVIDER_COLOR',
  'TOOLBAR_SHELL_RADIUS',
  'TOOLBAR_MINIMIZED_RADIUS',
  'TOOLBAR_CHIP_RADIUS',
  'TOOLBAR_EDGE_MARGIN',
  'TOOLBAR_DRAG_THRESHOLD',
  'TOOLBAR_ICON_HIT_SLOP',
  'TOOLBAR_SIDE_EDGE_ZONE_RATIO',
  'TOOLBAR_SIDE_EDGE_ZONE_MIN',
  'TOOLBAR_VERT_EDGE_ZONE_RATIO',
  'TOOLBAR_VERT_EDGE_ZONE_MIN',
];

console.log('Shared visual tokens');

check('PK4-C1: the one shared toolbar component imports the shared tokens it uses from lib/sharedToolbarChrome.ts, instead of either workspace re-declaring them', () => {
  for (const name of ['TOOLBAR_NAVY_BOTTOM', ...SHARED_TOKEN_NAMES]) {
    assert.ok(sharedToolbarSource.includes(`  ${name},\n`), `missing import of ${name}`);
  }
  assert.match(sharedToolbarSource, /\} from '@\/lib\/sharedToolbarChrome';/);
  // Genuine deduplication, not mere coexistence: neither host file
  // re-declares any of this chrome for itself any more.
  for (const source of [notebookSource, materialSource]) {
    assert.doesNotMatch(source, /^const TOOLBAR_NAVY_TOP = /m);
    assert.doesNotMatch(source, /^const TOOLBAR_SELECTED = /m);
    assert.doesNotMatch(source, /^const TOOLBAR_SHELL_RADIUS = /m);
    assert.doesNotMatch(source, /^const TOOLBAR_EDGE_MARGIN = /m);
    assert.doesNotMatch(source, /^const TOOLBAR_ICON_HIT_SLOP = /m);
    assert.doesNotMatch(source, /^const TOOLBAR_SIDE_EDGE_ZONE_RATIO = /m);
  }
});

check('the shared token values themselves are unchanged from PK4-B0', () => {
  assert.equal(TOOLBAR_NAVY_TOP, '#1E2E50');
  assert.equal(TOOLBAR_NAVY_BOTTOM, '#16233F');
  assert.equal(TOOLBAR_BORDER_COLOR, 'rgba(255,255,255,0.07)');
  assert.equal(TOOLBAR_SELECTED, '#5F86E8');
  assert.equal(TOOLBAR_ICON_IDLE, 'rgba(255,255,255,0.62)');
  assert.equal(TOOLBAR_ICON_DISABLED, 'rgba(255,255,255,0.26)');
  assert.equal(TOOLBAR_DIVIDER_COLOR, 'rgba(255,255,255,0.11)');
  assert.equal(TOOLBAR_SHELL_RADIUS, 22);
  assert.equal(TOOLBAR_MINIMIZED_RADIUS, 16);
  assert.equal(TOOLBAR_CHIP_RADIUS, 11);
  assert.equal(TOOLBAR_EDGE_MARGIN, 12);
  assert.equal(TOOLBAR_DRAG_THRESHOLD, 8);
  assert.deepEqual(TOOLBAR_ICON_HIT_SLOP, { top: 5, right: 5, bottom: 5, left: 5 });
  assert.equal(TOOLBAR_SIDE_EDGE_ZONE_RATIO, 0.28);
  assert.equal(TOOLBAR_SIDE_EDGE_ZONE_MIN, 300);
  assert.equal(TOOLBAR_VERT_EDGE_ZONE_RATIO, 0.2);
  assert.equal(TOOLBAR_VERT_EDGE_ZONE_MIN, 150);
});

console.log('\nDock-anchor math');

check('dockIsVertical / toolbarClamp pure behavior is unchanged', () => {
  assert.equal(dockIsVertical('leftCenter'), true);
  assert.equal(dockIsVertical('rightCenter'), true);
  for (const dock of ['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight']) {
    assert.equal(dockIsVertical(dock), false);
  }
  assert.equal(toolbarClamp(5, 0, 10), 5);
  assert.equal(toolbarClamp(-5, 0, 10), 0);
  assert.equal(toolbarClamp(50, 0, 10), 10);
});

check('PK4-C1: the shared toolbar component calls dockAnchorPoint/dockIsVertical directly — no per-workspace wrapper re-implementing them, in either host file', () => {
  assert.match(sharedToolbarSource, /dockAnchorPoint\(dock, containerSize, footprint\)/);
  assert.match(sharedToolbarSource, /dockIsVertical\(toolbarDock\)/);
  for (const source of [notebookSource, materialSource]) {
    assert.doesNotMatch(source, /function toolbarDockPoint[\s\S]{0,80}switch \(dock\)/);
    assert.doesNotMatch(source, /function dockPoint[\s\S]{0,80}switch \(dock\)/);
    assert.doesNotMatch(source, /dockAnchorPoint\(/);
    assert.doesNotMatch(source, /dockIsVertical\(/);
  }
});

check('resolveReleaseDock (drag-release dock selection) is now the one shared component\'s own — not duplicated per workspace', () => {
  assert.match(sharedToolbarSource, /resolveReleaseDock = useCallback/);
  for (const source of [notebookSource, materialSource]) {
    assert.doesNotMatch(source, /resolveReleaseDock/);
  }
});

check('dockAnchorPoint reproduces every one of the 8 dock cases', () => {
  const container = { width: 800, height: 1200 };
  const toolbar = { width: 200, height: 60 };
  const left = TOOLBAR_EDGE_MARGIN;
  const right = container.width - toolbar.width - TOOLBAR_EDGE_MARGIN;
  const top = TOOLBAR_EDGE_MARGIN;
  const bottom = container.height - toolbar.height - TOOLBAR_EDGE_MARGIN;
  const centerX = (container.width - toolbar.width) / 2;
  const centerY = (container.height - toolbar.height) / 2;

  assert.deepEqual(dockAnchorPoint('topLeft', container, toolbar), { x: left, y: top });
  assert.deepEqual(dockAnchorPoint('topRight', container, toolbar), { x: right, y: top });
  assert.deepEqual(dockAnchorPoint('leftCenter', container, toolbar), { x: left, y: centerY });
  assert.deepEqual(dockAnchorPoint('rightCenter', container, toolbar), { x: right, y: centerY });
  assert.deepEqual(dockAnchorPoint('bottomLeft', container, toolbar), { x: left, y: bottom });
  assert.deepEqual(dockAnchorPoint('bottomCenter', container, toolbar), { x: centerX, y: bottom });
  assert.deepEqual(dockAnchorPoint('bottomRight', container, toolbar), { x: right, y: bottom });
  assert.deepEqual(dockAnchorPoint('topCenter', container, toolbar), { x: centerX, y: top });
});

check('dockAnchorPoint clamps the center docks within [edge, edge]', () => {
  const container = { width: 100, height: 100 };
  const toolbar = { width: 500, height: 500 };
  const point = dockAnchorPoint('bottomCenter', container, toolbar);
  assert.equal(point.x, TOOLBAR_EDGE_MARGIN);
  assert.equal(point.y, TOOLBAR_EDGE_MARGIN);
});

console.log('\nNavySurface / GripDots');

check('NavySurface (SharedToolbarChrome.tsx) paints the exact two-stop gradient', () => {
  assert.match(sharedJsxSource, /<Stop offset="0" stopColor=\{TOOLBAR_NAVY_TOP\} \/>/);
  assert.match(sharedJsxSource, /<Stop offset="1" stopColor=\{TOOLBAR_NAVY_BOTTOM\} \/>/);
});

check('PK4-C1: the one shared toolbar component renders <NavySurface>/<ToolbarGripDots> directly (no wrapper), and neither host file duplicates the gradient/grip', () => {
  assert.match(sharedToolbarSource, /import \{ NavySurface, SharedToolbarGlyphPaths, ToolbarGripDots, type SharedToolbarGlyphName \} from '@\/components\/SharedToolbarChrome';/);
  assert.match(sharedToolbarSource, /<NavySurface/);
  assert.match(sharedToolbarSource, /<ToolbarGripDots \/>/);
  for (const source of [notebookSource, materialSource]) {
    assert.doesNotMatch(source, /<Stop offset="0" stopColor=\{TOOLBAR_NAVY_TOP\} \/>/);
    assert.doesNotMatch(source, /gripDots: \{\s*flexDirection: 'row',\s*gap: 3,\s*\}/);
    assert.doesNotMatch(source, /NavySurfaceBase/);
    assert.doesNotMatch(source, /GripDotsBase/);
  }
});

console.log('\nShared glyph paths');

const SHARED_GLYPHS = {
  pen: [
    'M5 23l1.4-4.6L19 5.8a2.3 2.3 0 0 1 3.3 3.3L9.6 21.6 5 23Z',
    'M16.6 8.2l3.2 3.2',
    'M5 23l1.4-4.6 3.2 3.2L5 23Z',
  ],
  highlighter: [
    'M6 20l-1.2 3.4 3.4-1.2L20 9.4l-2.2-2.2L6 20Z',
    'M17.8 7.2l2.2 2.2 2.2-2.2a1.55 1.55 0 0 0 0-2.2a1.55 1.55 0 0 0-2.2 0L17.8 7.2Z',
    'M5 24h6.5',
  ],
  eraser: [
    'M9 22h12',
    'M6.2 18.4l-1.6-1.6a2.2 2.2 0 0 1 0-3.1l7.6-7.6a2.2 2.2 0 0 1 3.1 0l4.4 4.4a2.2 2.2 0 0 1 0 3.1L15 20.4H8.6L6.2 18.4Z',
    'M10 9.6l5.6 5.6',
  ],
  'text/type': ['M6 8h11M6 8V6.5M17 8V6.5M11.5 8v14M9 22h5', 'M17 12h6M20 12v10M18.5 22h3'],
  undo: ['M10 8L6 12l4 4', 'M6 12h10.5a5.5 5.5 0 0 1 5.5 5.5v1'],
  redo: ['M18 8l4 4-4 4', 'M22 12H11.5A5.5 5.5 0 0 0 6 17.5v1'],
  hand: [
    'M11 13V7.5a1.7 1.7 0 0 1 3.4 0V13m0-1.5a1.7 1.7 0 0 1 3.4 0V14m0-1a1.7 1.7 0 0 1 3.3 0v4.5c0 3.3-2.4 5.8-6 5.8-2.4 0-4-1-5.4-2.8l-3-4a1.7 1.7 0 0 1 2.5-2.2L11 17V13Z',
  ],
  more: ['M7 9h14M11 9V7.5a1.2 1.2 0 0 1 1.2-1.2h3.6a1.2 1.2 0 0 1 1.2 1.2V9M9 9v12.5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9'],
  chevronUp: ['M7 17.5l7-7 7 7'],
  chevronLeft: ['M17 7l-6 7 6 7'],
  chevronRight: ['M11 7l6 7-6 7'],
};

check('every shared glyph\'s path data is present, verbatim, in SharedToolbarChrome.tsx', () => {
  for (const [glyph, paths] of Object.entries(SHARED_GLYPHS)) {
    for (const d of paths) {
      const needle = `d="${d}"`;
      assert.ok(sharedJsxSource.includes(needle), `SharedToolbarChrome.tsx missing ${glyph} path: ${d}`);
    }
  }
});

check('Notebook no longer duplicates the shared glyphs\' path data — its own ToolbarGlyphBase delegates to SharedToolbarGlyphPaths instead', () => {
  for (const [glyph, paths] of Object.entries(SHARED_GLYPHS)) {
    for (const d of paths) {
      const needle = `d="${d}"`;
      assert.ok(!notebookSource.includes(needle), `NotebookCanvas.tsx still duplicates ${glyph} path (should delegate): ${d}`);
    }
  }
  assert.match(notebookSource, /<SharedToolbarGlyphPaths name=\{sharedGlyphName\} color=\{color\} \/>/);
  assert.match(
    notebookSource,
    /const SHARED_TOOLBAR_GLYPH_NAMES: readonly ToolbarGlyphName\[\] = \[\s*'pen',\s*'highlighter',\s*'eraser',\s*'undo',\s*'redo',\s*'hand',\s*'more',\s*'trash',\s*'chevronUp',\s*'chevronLeft',\s*'chevronRight',\s*\];/,
  );
});

check('Notebook-only glyphs (select/insert/duplicate/chevronDown) stay local; Clear Page and Delete use shared glyphs', () => {
  assert.match(notebookSource, /name === 'select' \?/);
  assert.match(notebookSource, /name === 'insert' \?/);
  assert.match(notebookSource, /name === 'duplicate' \?/);
  assert.doesNotMatch(notebookSource, /name === 'trash' \?/);
  assert.doesNotMatch(notebookSource, /name === 'more' \?/);
  assert.match(notebookSource, /name === 'chevronDown' \?/);
  assert.doesNotMatch(sharedJsxSource, /'select'|'insert'|'duplicate'/);
});

check('PK4-C1: Course Material has zero local-only glyphs left — it renders SharedToolbarGlyphPaths directly (no MaterialFloatingToolbar-style GlyphBase wrapper at all)', () => {
  for (const [glyph, paths] of Object.entries(SHARED_GLYPHS)) {
    for (const d of paths) {
      const needle = `d="${d}"`;
      assert.ok(!materialSource.includes(needle), `Course Material screen still duplicates ${glyph} path (should delegate): ${d}`);
    }
  }
  assert.match(materialSource, /<SharedToolbarGlyphPaths name=\{materialGlyphName\(tool\)\} color=\{color\} \/>/);
  assert.doesNotMatch(materialSource, /MaterialFloatingToolbar/);
});

console.log('\nshared-toolbar-chrome: all checks passed');
