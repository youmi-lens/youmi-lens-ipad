import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const notebook = readFileSync(path.join(root, 'components/NotebookCanvas.tsx'), 'utf8');
const material = readFileSync(path.join(root, 'app/lecture-material/[lectureId]/[materialId].tsx'), 'utf8');
const toolbar = readFileSync(path.join(root, 'components/SharedAnnotationToolbar.tsx'), 'utf8');
const adapter = readFileSync(path.join(root, 'lib/courseMaterialAnnotationAdapter.ts'), 'utf8');

function options(source, name) {
  const match = source.match(new RegExp(`const ${name}(?:\\s*:[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  assert.ok(match, `${name} not found`);
  return [...match[1].matchAll(/\{ key: '([^']+)', value: '([^']+)'(?:, previewColor: '([^']+)')? \}/g)]
    .map(([, key, value, previewColor]) => ({ key, value, previewColor }));
}

assert.deepEqual(options(material, 'PEN_COLORS'), options(notebook, 'PEN_COLORS'), 'Pen swatch choices, order and values match Notebook');
const notebookHighlighter = options(notebook, 'HIGHLIGHTER_COLORS');
const materialHighlighter = options(material, 'HIGHLIGHTER_COLORS');
assert.deepEqual(materialHighlighter.map((item) => item.key), notebookHighlighter.map((item) => item.key), 'Highlighter palette order matches Notebook');
for (let i = 0; i < materialHighlighter.length; i += 1) {
  const rgb = notebookHighlighter[i].value.match(/rgba\((\d+),(\d+),(\d+),/);
  assert.ok(rgb, 'Notebook highlighter uses RGBA');
  const expectedHex = `#${rgb.slice(1).map((channel) => Number(channel).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  assert.equal(materialHighlighter[i].value, expectedHex, 'native PDF uses the same RGB with its existing separate opacity');
  assert.equal(materialHighlighter[i].previewColor, notebookHighlighter[i].value, 'toolbar swatch matches Notebook alpha');
}
assert.match(material, /useState<NativePdfAnnotationMode>\('pen'\)/);
assert.match(material, /useState<MaterialAnnotationMode>\('pen'\)/);
assert.match(notebook, /mode: 'write'/, 'Notebook starts with Pen selected');
assert.match(adapter, /MATERIAL_TOOL_ORDER: readonly AnnotationTool\[\] = \['pen', 'highlighter', 'text', 'select', 'eraser'\]/,
  'supported Course Material tools follow Notebook order');
assert.match(material, /onPress: hasNativeSelection \? \(\) => changeNativeSelection\('delete'\) : clearNativeCurrentPage/);
assert.match(toolbar, /const TOOL_DOCKS: SharedToolbarDock\[\]/, 'one toolbar owns all dock positions');
assert.match(toolbar, /option\.previewColor \?\? option\.value/, 'shared toolbar paints the preview separately from native PDF payload');
assert.equal((material.match(/<SharedAnnotationToolbar\b/g) ?? []).length, 2, 'native and legacy paths share one toolbar component');
console.log('course-material-toolbar-parity: swatches, initial tool, Clear Page, shared layout PASS');
