import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'components/PressableScale.tsx'), 'utf8');
assert.match(source, /scaleTo = 0\.98/);
assert.match(source, /opacityTo = 0\.94/);
assert.match(source, /duration: 70/);
assert.match(source, /duration: 150/);
assert.match(source, /scale\.stopAnimation\(\)/);
assert.match(source, /opacity\.stopAnimation\(\)/);
assert.match(source, /useNativeDriver: true/);
assert.doesNotMatch(source, /bounciness/);
assert.match(source, /if \(!disabled\)/);
assert.match(source, /onPressIn\?\.\(event\)/);
assert.match(source, /onPressOut\?\.\(event\)/);
for (const relative of [
  'app/recording.tsx',
  'app/mini-caption.tsx',
  'components/NotebookCanvas.tsx',
  'app/lecture/[id].tsx',
  'components/TranscriptReadList.tsx',
]) {
  const consumer = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.match(consumer, /PressableScale/, `${relative} uses shared interaction feedback`);
}
console.log('PressableScale interaction tests passed.');
