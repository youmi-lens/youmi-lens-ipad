/**
 * Processing-state live synchronization contract.
 *
 * These source-level regression guards cover the actual observation graph:
 * the app-level orchestrator and cloud refresh replace the one DataProvider
 * `lectures` state; Course, Detail, and Processing resolve their lecture by
 * ID from that context on render. No screen is permitted to retain a route
 * lecture snapshot or a screen-local processing copy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const store = stripComments(read('../lib/store.tsx'));
const orchestrator = stripComments(read('../lib/useProcessingOrchestrator.ts'));
const course = stripComments(read('../app/course/[id].tsx'));
const detail = stripComments(read('../app/lecture/[id].tsx'));
const processing = stripComments(read('../app/processing.tsx'));
const resume = read('../lib/processingResume.mjs');

console.log('Processing live synchronization contract');

check('a persisted/orchestrator lecture patch replaces the shared lectures state, not screen-local state', () => {
  const update = store.slice(store.indexOf('const updateLecture = useCallback'), store.indexOf('const moveLectureToCourse'));
  assert.match(update, /setLectures\(\(prev\) => prev\.map\(\(l\) => \(l\.id === id \? \{ \.\.\.l, \.\.\.stamped \} : l\)\)\)/);
  assert.match(orchestrator, /updateLecture\(lectureId, \{ \.\.\.patch, lastSyncedAt: new Date\(\)\.toISOString\(\) \}\)/);
});

check('cloud completion refresh also replaces that same shared lectures state', () => {
  const refresh = store.slice(store.indexOf('const refreshCloudLibrary = useCallback'), store.indexOf('// Realtime is deliberately'));
  assert.match(refresh, /setLectures\(merged\.lectures\)/);
  assert.match(store, /createCloudRealtimeInvalidator\(refreshCloudLibrary\)/);
});

check('Course observes the current context collection on every render, without a local lecture snapshot', () => {
  assert.match(course, /const \{[\s\S]*lecturesForCourse[\s\S]*\} = useData\(\);/);
  assert.match(course, /const lectures = course\s*\? \[\.\.\.lecturesForCourse\(course\.id\)\]/);
  assert.doesNotMatch(course, /useState<Lecture\[\]>|useState\(lectures/);
});

check('Lecture Detail observes the current lecture by route ID from context, never a route lecture object', () => {
  assert.match(detail, /const \{ courses, getLecture,[\s\S]*\} = useData\(\);/);
  assert.match(detail, /const lecture = getLecture\(params\.id\);/);
  assert.doesNotMatch(detail, /params\.lecture|useState<Lecture(?:\s*\||\s*>)/);
});

check('Processing observes the current lecture by route ID from context, never a route lecture object', () => {
  assert.match(processing, /const \{ getLecture, getCourse, updateLecture \} = useData\(\);/);
  assert.match(processing, /const lecture = getLecture\(params\.lectureId\);/);
  assert.doesNotMatch(processing, /params\.lecture(?!Id)|useState<Lecture(?:\s*\||\s*>)/);
});

check('all three surfaces use the same terminal ready field after an update', () => {
  assert.match(course, /if \(isLectureComplete\(lecture\)\) \{/);
  assert.match(detail, /lecture\.processingStatus === 'ready'/);
  assert.match(processing, /const processingDone = processingStatus === 'ready';/);
  assert.match(resume, /return lecture\.processingStatus === 'ready';/);
});

check('a live processing-to-ready poll writes ready then stops, so mounted screens receive one terminal update', () => {
  const tick = orchestrator.slice(orchestrator.indexOf('const tick = async () => {'), orchestrator.indexOf('void tick();'));
  assert.match(tick, /const merged = mergeProcessingSnapshot\(reference, remote\);/);
  assert.match(tick, /const result = resolvePollTick\(merged, state\.attempts, MAX_POLL_ATTEMPTS\);/);
  assert.match(tick, /updateLecture\(lectureId, \{ \.\.\.result\.patch, lastSyncedAt: new Date\(\)\.toISOString\(\) \}\)/);
  assert.match(tick, /if \(result\.action === 'stop'\) \{\s*stop\(\);/);
});

check('relaunch rehydrates the same persisted lectures collection and cannot promote partial artifacts to ready', () => {
  assert.match(store, /setLectures\(normalizedLocalLectures\)/);
  assert.match(store, /setLectures\(merged\.lectures\)/);
  const statusFn = course.slice(course.indexOf('function lectureStatus'), course.indexOf('export default function CourseDetailScreen'));
  assert.doesNotMatch(statusFn, /lecture\.transcript\s*&&\s*\(lecture\.summaryEn\s*\|\|\s*lecture\.summaryZh\)/);
});

console.log(`\nprocessing-live-synchronization: ${passed} checks passed`);
