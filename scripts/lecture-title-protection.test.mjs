/**
 * Regression matrix for Lecture title protection.
 *
 * Background: a production incident left many `recordings` rows named
 * "Untitled Lecture". The cloud merge only tested the remote title for
 * emptiness, so the literal placeholder string — being truthy — overwrote real
 * user titles. These tests pin the invariant that makes that impossible:
 *
 *     a VALID title is never replaced by a FALLBACK one, in either direction,
 *     regardless of any timestamp.
 *
 * Renaming must keep working, so valid-vs-valid contests are still decided by
 * freshness. Both properties are asserted below.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LECTURE_TITLE,
  isFallbackLectureTitle,
  isValidLectureTitle,
  resolveMergedLectureTitle,
} from '../lib/lectureTitle.mjs';

const OLD = '2024-01-01T00:00:00.000Z';
const MID = '2024-06-01T00:00:00.000Z';
const NEW = '2024-12-01T00:00:00.000Z';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Classifier
// ─────────────────────────────────────────────────────────────────────────────
console.log('classifier');

check('undefined / null / non-strings are fallback', () => {
  assert.equal(isFallbackLectureTitle(undefined), true);
  assert.equal(isFallbackLectureTitle(null), true);
  assert.equal(isFallbackLectureTitle(42), true);
  assert.equal(isFallbackLectureTitle({}), true);
});

check('empty and whitespace-only are fallback', () => {
  assert.equal(isFallbackLectureTitle(''), true);
  assert.equal(isFallbackLectureTitle('   '), true);
  assert.equal(isFallbackLectureTitle('\t\n  '), true);
});

check('exact system placeholders are fallback, trimmed + case-folded', () => {
  assert.equal(isFallbackLectureTitle('Untitled Lecture'), true);
  assert.equal(isFallbackLectureTitle('  Untitled Lecture  '), true);
  assert.equal(isFallbackLectureTitle('untitled lecture'), true);
  assert.equal(isFallbackLectureTitle('UNTITLED LECTURE'), true);
  // the backend's own default (server/uploadAudio.mjs cleanText)
  assert.equal(isFallbackLectureTitle('Lecture'), true);
});

// Case 24 — a title is not a placeholder merely because it contains the word.
check('titles containing "Untitled" but not equal to it stay valid', () => {
  assert.equal(isValidLectureTitle('Untitled Lecture 3'), true);
  assert.equal(isValidLectureTitle('Untitled thoughts on Kant'), true);
  assert.equal(isValidLectureTitle('My Untitled Lecture'), true);
  assert.equal(isValidLectureTitle('Lecture 7'), true);
  assert.equal(isValidLectureTitle('Untitled'), true);
});

check('legitimately short titles stay valid', () => {
  assert.equal(isValidLectureTitle('A'), true);
  assert.equal(isValidLectureTitle('物理'), true);
  assert.equal(isValidLectureTitle('CS'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Merge matrix
// ─────────────────────────────────────────────────────────────────────────────
console.log('merge matrix');

// 1 — valid local + fallback remote
check('1. valid local beats fallback remote', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'CS111 Lecture 3',
    remoteTitle: 'Untitled Lecture',
    remoteUpdatedAt: NEW,
  });
  assert.equal(r.title, 'CS111 Lecture 3');
  assert.equal(r.source, 'local');
});

// 2 — fallback local + valid remote
check('2. valid remote beats fallback local', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Untitled Lecture',
    remoteTitle: 'CS111 Lecture 3',
    remoteUpdatedAt: OLD,
  });
  assert.equal(r.title, 'CS111 Lecture 3');
  assert.equal(r.source, 'remote');
});

// 3 — valid local older + valid remote newer
check('3. valid+valid, local rename older than row → remote wins', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Old Name',
    localTitleUpdatedAt: OLD,
    remoteTitle: 'New Name',
    remoteUpdatedAt: NEW,
  });
  assert.equal(r.title, 'New Name');
});

// 4 — valid local newer + valid remote older
check('4. valid+valid, local rename newer than row → local wins', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Freshly Renamed',
    localTitleUpdatedAt: NEW,
    remoteTitle: 'Stale Remote',
    remoteUpdatedAt: OLD,
  });
  assert.equal(r.title, 'Freshly Renamed');
});

// 5/6/7 — valid local vs absent remote title
check('5. valid local survives null remote title', () => {
  const r = resolveMergedLectureTitle({ localTitle: 'Kept', remoteTitle: null, remoteUpdatedAt: NEW });
  assert.equal(r.title, 'Kept');
});
check('6. valid local survives empty remote title', () => {
  const r = resolveMergedLectureTitle({ localTitle: 'Kept', remoteTitle: '', remoteUpdatedAt: NEW });
  assert.equal(r.title, 'Kept');
});
check('7. valid local survives whitespace remote title', () => {
  const r = resolveMergedLectureTitle({ localTitle: 'Kept', remoteTitle: '   ', remoteUpdatedAt: NEW });
  assert.equal(r.title, 'Kept');
});

// 8 — the exact reported regression, with NO local titleUpdatedAt at all.
// This is the case the old merge got wrong: no stamp meant preferLocalTitle
// was false, so the truthy placeholder won.
check('8. valid local with NO titleUpdatedAt survives "Untitled Lecture" remote', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Organic Chemistry Week 4',
    localTitleUpdatedAt: undefined,
    remoteTitle: 'Untitled Lecture',
    remoteUpdatedAt: NEW,
  });
  assert.equal(r.title, 'Organic Chemistry Week 4');
  assert.equal(r.source, 'local');
});

// 9 — both fallback
check('9. fallback + fallback stays a placeholder', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Untitled Lecture',
    remoteTitle: 'Untitled Lecture',
  });
  assert.equal(r.title, 'Untitled Lecture');
  assert.equal(r.source, 'fallback');
});
check('9b. empty on both sides falls back to the default label', () => {
  const r = resolveMergedLectureTitle({ localTitle: null, remoteTitle: undefined });
  assert.equal(r.title, DEFAULT_LECTURE_TITLE);
});

// 10 / 11 — missing timestamps must never let a placeholder through
check('10. missing remote titleUpdatedAt cannot promote a fallback remote', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Valid Local',
    localTitleUpdatedAt: OLD,
    remoteTitle: 'Lecture',
    remoteTitleUpdatedAt: undefined,
    remoteUpdatedAt: NEW,
  });
  assert.equal(r.title, 'Valid Local');
});
check('11. missing local titleUpdatedAt cannot demote a valid local title', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Valid Local',
    localTitleUpdatedAt: undefined,
    remoteTitle: '',
    remoteUpdatedAt: NEW,
  });
  assert.equal(r.title, 'Valid Local');
});

// 12 — the second half of the regression: an unrelated write bumps the row's
// updated_at, which must not hand the contest to a placeholder.
check('12. newer unrelated updatedAt does not let a fallback overwrite', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Linear Algebra 9',
    localTitleUpdatedAt: OLD,
    remoteTitle: 'Untitled Lecture',
    remoteUpdatedAt: NEW, // transcript/summary landed after the rename
  });
  assert.equal(r.title, 'Linear Algebra 9');
});

// 13–18 — content edits bump only the row-level updated_at. Sweeping that
// timestamp across its whole range must never alter a settled title.
console.log('content edits cannot change the title');
for (const edit of ['transcript', 'summary', 'notes', 'marks', 'notebook', 'course assignment']) {
  check(`${edit} update leaves a valid local title intact`, () => {
    for (const bumped of [OLD, MID, NEW, undefined]) {
      const r = resolveMergedLectureTitle({
        localTitle: 'Thermodynamics II',
        localTitleUpdatedAt: MID,
        remoteTitle: 'Untitled Lecture',
        remoteUpdatedAt: bumped,
      });
      assert.equal(r.title, 'Thermodynamics II', `bumped=${bumped}`);
    }
  });
}

// Static guard: only the rename path may stamp titleUpdatedAt. If a future
// edit path starts writing it, this fails loudly.
check('only renameLecture + the merge write titleUpdatedAt in store.tsx', () => {
  const storePath = fileURLToPath(new URL('../lib/store.tsx', import.meta.url));
  const source = readFileSync(storePath, 'utf8');
  const writes = source.match(/titleUpdatedAt:\s*/g) ?? [];
  // 1) renameLecture's optimistic local update, 2) the merged lecture object.
  assert.equal(writes.length, 2, `unexpected titleUpdatedAt writes: ${writes.length}`);
  assert.match(source, /title: trimmed, titleUpdatedAt: now/);
});

// 21 / 22 / 23 — renaming must keep working.
console.log('renames still work');
check('21. an explicit valid rename survives the next merge', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Renamed Once',
    localTitleUpdatedAt: NEW,
    remoteTitle: 'Untitled Lecture',
    remoteUpdatedAt: MID,
  });
  assert.equal(r.title, 'Renamed Once');
});
check('22. a second valid rename also survives', () => {
  const first = resolveMergedLectureTitle({
    localTitle: 'Renamed Once',
    localTitleUpdatedAt: MID,
    remoteTitle: 'Renamed Once',
    remoteUpdatedAt: MID,
  });
  assert.equal(first.title, 'Renamed Once');
  const second = resolveMergedLectureTitle({
    localTitle: 'Renamed Twice',
    localTitleUpdatedAt: NEW,
    remoteTitle: 'Renamed Once',
    remoteUpdatedAt: MID,
  });
  assert.equal(second.title, 'Renamed Twice');
});
check('23. a valid rename made on another device propagates in', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Local Name',
    localTitleUpdatedAt: OLD,
    remoteTitle: 'Renamed On iPad',
    remoteUpdatedAt: NEW,
  });
  assert.equal(r.title, 'Renamed On iPad');
  assert.equal(r.source, 'remote');
});
check('valid → valid rename is never blocked by the fallback guard', () => {
  const r = resolveMergedLectureTitle({
    localTitle: 'Untitled Lecture 3', // valid despite the word
    localTitleUpdatedAt: NEW,
    remoteTitle: 'Untitled Lecture', // placeholder
    remoteUpdatedAt: NEW,
  });
  assert.equal(r.title, 'Untitled Lecture 3');
});

// Idempotence — repeated refreshes must not oscillate.
check('merging twice is stable', () => {
  const once = resolveMergedLectureTitle({
    localTitle: 'Stable Title',
    remoteTitle: 'Untitled Lecture',
    remoteUpdatedAt: NEW,
  });
  const twice = resolveMergedLectureTitle({
    localTitle: once.title,
    localTitleUpdatedAt: once.titleUpdatedAt,
    remoteTitle: 'Untitled Lecture',
    remoteUpdatedAt: NEW,
  });
  assert.equal(twice.title, 'Stable Title');
});

console.log(`\nlecture title protection: ${passed} checks passed`);
