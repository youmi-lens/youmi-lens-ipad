import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const home = read('app/(tabs)/index.tsx');
for (const literal of [
  'Courses keep every recording',
  'Record in class',
  'Live English captions with instant Chinese translation',
  'Review the summary',
  'Keep your notes',
]) {
  assert.equal(home.includes(literal), false, `Home must not hardcode onboarding English: ${literal}`);
}

const lecture = read('app/lecture/[id].tsx');
for (const literal of ['Handwriting ·', "'stroke'", "'strokes'"]) {
  assert.equal(lecture.includes(literal), false, `Lecture Detail must localize ${literal}`);
}

const localizedFiles = [
  'app/auth.tsx', 'app/auth/callback.tsx', 'app/(tabs)/index.tsx', 'app/course/[id].tsx',
  'app/lecture/[id].tsx', 'app/processing.tsx', 'app/recording.tsx', 'app/mini-caption.tsx',
  'components/FloatingMiniCaption.tsx',
];
const forbiddenVisibleLiterals = [
  'Please enter your email.', 'Please enter a valid email address.', 'Reading from Files…',
  'Record your first lecture to start building this course library.', 'Translating…',
];
for (const path of localizedFiles) {
  const source = read(path);
  for (const literal of forbiddenVisibleLiterals) {
    assert.equal(source.includes(literal), false, `${path} contains hardcoded visible copy: ${literal}`);
  }
}

console.log('hardcoded UI string regression tests passed.');
