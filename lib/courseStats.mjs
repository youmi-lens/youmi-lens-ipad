/**
 * Per-course aggregates for the Courses grid.
 *
 * Extracted from app/(tabs)/courses.tsx so the cost is measurable and pinned by
 * a test. The screen used to derive these per card:
 *
 *     const courseLectures = lecturesForCourse(course.id)          // full scan
 *     const latest = [...courseLectures].sort(byDateDesc)[0]       // copy + sort
 *     const duration = courseLectures.reduce(...)                  // another pass
 *     const ready = courseLectures.filter(...).length              // another pass
 *
 * — O(courses × lectures) with several allocations per card, and unmemoized, so
 * it re-ran on every render. On a large library that work landed between the
 * Courses tap and the first painted frame, which is what made entering the tab
 * feel like the app had paused.
 *
 * This does one pass over `lectures` regardless of how many courses exist, and
 * finds the newest date with a string comparison instead of sorting (ISO-8601
 * timestamps sort lexicographically, which is why `>` is safe here).
 */

/**
 * @typedef {{ count: number, duration: number, ready: number, latestDate: string|undefined }} CourseStat
 */

/**
 * @param {Array<{ courseId: string, durationMillis?: number, processingStatus?: string, date?: string }>} lectures
 * @returns {Map<string, CourseStat>} keyed by courseId; courses with no
 *   lectures are simply absent, so callers should default a missing entry.
 */
export function buildCourseStats(lectures) {
  /** @type {Map<string, CourseStat>} */
  const stats = new Map();
  if (!Array.isArray(lectures)) return stats;

  for (const lecture of lectures) {
    if (!lecture || typeof lecture.courseId !== 'string') continue;
    let entry = stats.get(lecture.courseId);
    if (!entry) {
      entry = { count: 0, duration: 0, ready: 0, latestDate: undefined };
      stats.set(lecture.courseId, entry);
    }
    entry.count += 1;
    entry.duration += Number(lecture.durationMillis) || 0;
    if (lecture.processingStatus === 'ready') entry.ready += 1;
    if (typeof lecture.date === 'string' && (!entry.latestDate || lecture.date > entry.latestDate)) {
      entry.latestDate = lecture.date;
    }
  }

  return stats;
}

/** Total recorded duration across every supplied lecture. */
export function totalLectureDuration(lectures) {
  if (!Array.isArray(lectures)) return 0;
  let total = 0;
  for (const lecture of lectures) total += Number(lecture?.durationMillis) || 0;
  return total;
}
