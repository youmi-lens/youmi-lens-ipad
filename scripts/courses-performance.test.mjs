/**
 * Courses entrance: data preparation cost and correctness.
 *
 * The Courses tab used to derive its grid with a full lecture scan plus an
 * array copy and sort PER CARD, unmemoized — O(courses × lectures) on every
 * render, running before the screen's first frame. These tests pin both halves
 * of the fix: the aggregates are still correct, and the cost is now linear in
 * the number of lectures rather than growing with the course count.
 */
import assert from 'node:assert/strict';

import { buildCourseStats, totalLectureDuration } from '../lib/courseStats.mjs';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
};

const makeLibrary = (lectureCount, courseCount) =>
  Array.from({ length: lectureCount }, (_, i) => ({
    id: `lec_${i}`,
    courseId: `course_${i % courseCount}`,
    durationMillis: 1000,
    processingStatus: i % 3 === 0 ? 'ready' : 'pending',
    // Deliberately unordered so "newest" cannot be satisfied by input order.
    date: new Date(Date.UTC(2024, 0, 1 + ((i * 7919) % 500))).toISOString(),
  }));

console.log('correctness');

check('aggregates count, duration, ready and newest date per course', () => {
  const stats = buildCourseStats([
    { courseId: 'a', durationMillis: 1000, processingStatus: 'ready', date: '2024-01-02T00:00:00.000Z' },
    { courseId: 'a', durationMillis: 2500, processingStatus: 'pending', date: '2024-03-09T00:00:00.000Z' },
    { courseId: 'a', durationMillis: 500, processingStatus: 'ready', date: '2024-02-01T00:00:00.000Z' },
    { courseId: 'b', durationMillis: 7000, processingStatus: 'ready', date: '2023-11-11T00:00:00.000Z' },
  ]);
  assert.deepEqual(stats.get('a'), {
    count: 3,
    duration: 4000,
    ready: 2,
    latestDate: '2024-03-09T00:00:00.000Z',
  });
  assert.deepEqual(stats.get('b'), {
    count: 1,
    duration: 7000,
    ready: 1,
    latestDate: '2023-11-11T00:00:00.000Z',
  });
});

check('newest date matches an explicit sort, on shuffled input', () => {
  const lectures = makeLibrary(400, 5);
  const stats = buildCourseStats(lectures);
  for (const [courseId, stat] of stats) {
    const expected = lectures
      .filter((l) => l.courseId === courseId)
      .map((l) => l.date)
      .sort((a, b) => b.localeCompare(a))[0];
    assert.equal(stat.latestDate, expected, courseId);
  }
});

check('a course with no lectures is absent (callers default it)', () => {
  const stats = buildCourseStats([{ courseId: 'a', durationMillis: 1, date: '2024-01-01T00:00:00.000Z' }]);
  assert.equal(stats.get('empty-course'), undefined);
});

check('malformed rows are skipped, not thrown on', () => {
  const stats = buildCourseStats([
    null,
    undefined,
    { courseId: null },
    { courseId: 'a' }, // no duration / status / date
    { courseId: 'a', durationMillis: 'nonsense', date: 5 },
  ]);
  assert.deepEqual(stats.get('a'), { count: 2, duration: 0, ready: 0, latestDate: undefined });
});

check('non-array input is tolerated', () => {
  assert.equal(buildCourseStats(undefined).size, 0);
  assert.equal(totalLectureDuration(undefined), 0);
});

check('totalLectureDuration sums the library', () => {
  assert.equal(totalLectureDuration(makeLibrary(250, 8)), 250 * 1000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cost. The product requirement is 10 → 500 lectures without a visible pause.
// ─────────────────────────────────────────────────────────────────────────────
console.log('cost at the required library sizes');

/**
 * Counts `courseId` reads while aggregating. The absolute number is a small
 * constant multiple of the library size (the implementation reads the field to
 * validate it and again to key the map); what matters is how it SCALES.
 */
const countCourseIdReads = (lectures) => {
  let reads = 0;
  const counted = lectures.map((l) => ({
    ...l,
    get courseId() {
      reads += 1;
      return l.courseId;
    },
  }));
  const stats = buildCourseStats(counted);
  return { reads, stats };
};

for (const size of [10, 50, 100, 250, 500]) {
  check(`${size} lectures: work is bounded by a constant × library size`, () => {
    const { reads, stats } = countCourseIdReads(makeLibrary(size, Math.max(1, Math.round(size / 10))));
    // A single pass touches each lecture a fixed number of times. The old
    // per-card version would have been ~size × courseCount here.
    assert.ok(reads <= size * 3, `${size} lectures caused ${reads} reads`);
    assert.equal([...stats.values()].reduce((n, s) => n + s.count, 0), size);
  });
}

check('work does NOT grow with the course count at a fixed library size', () => {
  // This is the actual regression guard: the old code scanned all 500 lectures
  // once per course, so going 5 → 100 courses multiplied the work by 20.
  const few = countCourseIdReads(makeLibrary(500, 5)).reads;
  const many = countCourseIdReads(makeLibrary(500, 100)).reads;
  // Allow only the per-new-course map insert to differ (95 extra courses).
  assert.ok(
    Math.abs(many - few) <= 100,
    `5 courses → ${few} reads, 100 courses → ${many} reads (should be ~equal)`,
  );
});

check('work grows linearly with library size', () => {
  const at100 = countCourseIdReads(makeLibrary(100, 10)).reads;
  const at500 = countCourseIdReads(makeLibrary(500, 10)).reads;
  const ratio = at500 / at100;
  assert.ok(ratio > 4.5 && ratio < 5.5, `5× the lectures should be ~5× the work, saw ${ratio}×`);
});

console.log(`\ncourses performance: ${passed} checks passed`);
