import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildLectureMove, moveTargets } from '../lib/lectureMove.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

const source = await readFile(new URL('../lib/lectureMove.mjs', import.meta.url), 'utf8');
const store = await readFile(new URL('../lib/store.tsx', import.meta.url), 'utf8');
const detail = await readFile(new URL('../app/lecture/[id].tsx', import.meta.url), 'utf8');
const realtime = store.slice(store.indexOf('const refreshCloudLibrary'), store.indexOf('// Hydrate only'));

const sourceCourse = { id: '11111111-1111-4111-8111-111111111111', name: 'CS 111', icon: 'code-outline', tint: '#eef', accent: '#123' };
const targetCourse = { id: '22222222-2222-4222-8222-222222222222', name: 'MA 123', icon: 'calculator-outline', tint: '#efe', accent: '#234' };
const deletedCourse = { id: '33333333-3333-4333-8333-333333333333', name: 'Archived', icon: 'archive-outline', tint: '#eee', accent: '#345', deletedAt: '2026-01-01T00:00:00.000Z' };
const courses = [sourceCourse, targetCourse, deletedCourse];
const lecture = {
  id: 'lecture_local_9', remoteRecordingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', courseId: sourceCourse.id,
  title: 'Introduction to Python', localAudioUri: 'file:///lecture.m4a', storagePath: 'audio/x.m4a',
  transcript: 'Transcript', translatedTranscript: '翻译', summaryEn: 'Summary', summaryZh: '摘要', sourceSummary: 'Source', translatedSummary: 'Translated',
  notes: 'Notes', noteStrokes: [{ points: [] }], noteImages: [{ uri: 'file:///note.jpg' }], markedTimestamps: [12000],
  createdAt: '2026-01-02T00:00:00.000Z', date: '2026-01-02T00:00:00.000Z', deletedAt: null, deletionUpdatedAt: '2026-01-03T00:00:00.000Z',
  processingStatus: 'ready', uploadStatus: 'uploaded', keyPoints: ['x'], durationMillis: 12_000, status: 'local_recorded',
};

function planFor(mod = { buildLectureMove }) {
  const plan = mod.buildLectureMove({ lecture, targetCourse, courses });
  assert.ok(plan, 'expected a valid move plan');
  return plan;
}

check('M1-M7. only active non-current UUID courses are eligible; destination identity is course.id', () => {
  assert.deepEqual(moveTargets(courses, lecture).map((course) => course.id), [targetCourse.id]);
  const plan = planFor();
  assert.equal(plan.lecture.courseId, targetCourse.id);
  assert.equal(plan.remotePatch.course_id, targetCourse.id);
  assert.notEqual(plan.remotePatch.course_id, targetCourse.name);
  assert.equal(plan.remotePatch.course, targetCourse.name, 'legacy text remains coherent');
});

check('M8-M15/D1-D13. move preserves identity and every non-association field without duplicates or source deletion', () => {
  const plan = planFor();
  assert.equal(plan.lecture.id, lecture.id);
  assert.equal(plan.lecture.remoteRecordingId, lecture.remoteRecordingId);
  for (const [key, value] of Object.entries(lecture)) {
    if (key !== 'courseId') assert.deepEqual(plan.lecture[key], value, `${key} changed during move`);
  }
  const moved = [plan.lecture];
  assert.equal(moved.filter((item) => item.id === lecture.id).length, 1);
  assert.equal(courses.length, 3, 'source Course must remain even when empty');
  const back = buildLectureMove({ lecture: plan.lecture, targetCourse: sourceCourse, courses });
  assert.equal(back?.lecture.courseId, sourceCourse.id, 'moving back must work');
});

check('M16. legacy name-associated lecture becomes canonical at the selected target UUID', () => {
  const legacy = { ...lecture, courseId: 'cloud_course_some-course' };
  const plan = buildLectureMove({ lecture: legacy, targetCourse, courses: [targetCourse] });
  assert.equal(plan?.lecture.courseId, targetCourse.id);
  assert.equal(plan?.remotePatch.course_id, targetCourse.id);
});

check('C1-C6. store uses existing-row remote patching and existing canonical Realtime invalidation', () => {
  assert.match(store, /const moveLectureToCourse = useCallback/);
  assert.match(store, /buildLectureMove\(\{ lecture, targetCourse, courses: coursesRef\.current \}\)/);
  assert.match(store, /pushRecordingPatch\(plan\.remotePatch, plan\.remoteIds, 'lecture move'\)/);
  assert.match(store, /table: 'recordings'/);
  assert.match(realtime, /refreshCloudLibrary/);
  assert.doesNotMatch(store.slice(store.indexOf('const moveLectureToCourse'), store.indexOf('const saveInProgressLecture')), /createLecture|deleteCourse|makeUuid/);
});

check('UI parity. Lecture Detail exposes one shared picker and hides it for deleted lectures', () => {
  assert.match(detail, /MoveLectureToCourseModal/);
  assert.match(detail, /!lecture\.deletedAt/);
  assert.match(detail, /courses=\{courses\}/);
  assert.match(source, /!course\.deletedAt && course\.id !== lecture\.courseId/);
});

async function importMutation(replace) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'youmi-lecture-move-'));
  const file = path.join(dir, 'lectureMove.mjs');
  await writeFile(file, replace(source));
  try { return await import(`${pathToFileURL(file).href}?${Date.now()}-${Math.random()}`); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function expectMutationDetected(name, replace, verify) {
  const mutated = await importMutation(replace);
  assert.throws(() => verify(mutated), undefined, `${name} mutation was not detected`);
}

await expectMutationDetected('A: name used as canonical identity', (s) => s.replace('course_id: targetCourse.id', 'course_id: targetCourse.name'), (m) => {
  assert.equal(planFor(m).remotePatch.course_id, targetCourse.id);
});
await expectMutationDetected('B/F: replacement lecture UUID / clone', (s) => s.replace('lecture: { ...lecture, courseId:', "lecture: { ...lecture, id: 'replacement', courseId:"), (m) => {
  assert.equal(planFor(m).lecture.id, lecture.id);
});
await expectMutationDetected('C: omitted remote course_id patch', (s) => s.replace('remotePatch: { course_id: targetCourse.id, course: targetCourse.name }', 'remotePatch: { course: targetCourse.name }'), (m) => {
  assert.equal(planFor(m).remotePatch.course_id, targetCourse.id);
});
await expectMutationDetected('D: source course deletion', (s) => s.replace('return {\n    lecture:', 'courses.pop();\n  return {\n    lecture:'), (m) => {
  const copy = [...courses]; m.buildLectureMove({ lecture, targetCourse, courses: copy }); assert.equal(copy.length, courses.length);
});
await expectMutationDetected('E: deleted destination allowed', (s) => s.replace('!course.deletedAt && course.id !== lecture.courseId', 'course.id !== lecture.courseId'), (m) => {
  assert.deepEqual(m.moveTargets(courses, lecture).map((course) => course.id), [targetCourse.id]);
});

console.log(`lecture-move: ${passed} contract checks + 5 isolated mutation checks passed`);
