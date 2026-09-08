/**
 * P0 classroom incident (2026-09-03): a real ~60-minute class displayed as
 * ~345 minutes, with the on-screen timer visibly climbing far faster than
 * real time near the end of class.
 *
 * Root cause (app/recording.tsx): `resumeLecture` is a LIVE read from the
 * store (`getLecture(resumeLectureId)`, re-evaluated every render). The
 * legacy-engine session duration was computed as
 *   resumeLecture.durationMillis + <live recorder elapsed>
 * and this screen's own autosave (persistProgress, every ~5s while
 * recording) writes that SAME combined value back into the store as the
 * lecture's durationMillis. Because the baseline was read live instead of
 * snapshotted, each autosave fed an already-inflated total back into the
 * next render's baseline, and the live recorder's still-running elapsed time
 * got re-added on top of it again — a feedback loop that compounds roughly
 * every 5 seconds for the rest of any RESUMED recording session (quadratic
 * growth, not linear), for as long as recording continues after a resume.
 *
 * This never affects a fresh, single-continuous-mount recording (isResume is
 * false for its entire lifetime), which is why a normal uninterrupted class
 * is unaffected — only a class where the recording screen was left and
 * reopened for an in-progress lecture (a real, ordinary interaction: opening
 * Notebook/materials mid-class, a backgrounding-triggered resume, etc.).
 *
 * Fix: snapshot the resume baseline ONCE at mount into a ref
 * (priorDurationMillisRef), exactly like every other prior* value this
 * screen already carries forward from a resumed lecture (priorCaptionLinesRef,
 * priorMarksRef, priorAudioUriRef). The baseline no longer mutates mid-session,
 * so duration grows linearly with real time regardless of how many autosaves
 * fire.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const recordingScreen = read('../app/recording.tsx');

console.log('Resume-session duration: no live-store feedback loop');

check('the resume duration baseline is snapshotted once at mount, like the other prior* refs', () => {
  assert.match(
    recordingScreen,
    /const priorDurationMillisRef = useRef<number>\(resumeLecture\?\.durationMillis \?\? 0\);/,
    'priorDurationMillisRef must exist and be seeded once from resumeLecture at mount, not read live',
  );
  // It must sit alongside the screen's other established mount-once resume
  // snapshots, not stand alone as a one-off exception.
  const priorRefsBlock = recordingScreen.slice(
    recordingScreen.indexOf('const priorCaptionLinesRef'),
    recordingScreen.indexOf('const progressCreatedRef'),
  );
  assert.match(priorRefsBlock, /priorMarksRef/);
  assert.match(priorRefsBlock, /priorAudioUriRef/);
  assert.match(priorRefsBlock, /priorDurationMillisRef/);
});

check('sessionDurationMillis reads the frozen snapshot, never the live resumeLecture.durationMillis', () => {
  const formula = recordingScreen.slice(
    recordingScreen.indexOf('const sessionDurationMillis ='),
    recordingScreen.indexOf('const seconds = Math.floor'),
  );
  assert.match(
    formula,
    /priorDurationMillisRef\.current \+ \(isReviewingResume \? 0 : durationMillis\)/,
    'the resume branch must add the live recorder duration on top of the frozen baseline only',
  );
  assert.doesNotMatch(
    formula,
    /resumeLecture\?\.durationMillis/,
    'must not read resumeLecture.durationMillis live inside the duration formula — that is the regression this fix closes',
  );
});

check('autosave (persistProgress) and Stop & Save both derive from sessionDurationMillis, so the fix covers both paths', () => {
  assert.match(recordingScreen, /durationRef\.current = sessionDurationMillis;/);
  assert.match(recordingScreen, /const finalDuration = sessionDurationMillis;/);
});

console.log('\nNumeric proof: old formula compounds, new formula stays linear');

/**
 * Simulates ~1 minute of a resumed session at the real autosave cadence
 * (~5s), comparing the OLD buggy recurrence against the FIXED one.
 *   old:  D_n = D_{n-1} + raw(t_n)          (baseline re-read live each autosave)
 *   fixed: D_n = D0 + raw(t_n)              (baseline frozen at mount)
 * raw(t) is the live recorder's own elapsed time since the resume began —
 * it is never reset between autosaves in either version; only the baseline
 * read differs.
 */
check('old formula (live baseline) runs away superlinearly; fixed formula (frozen baseline) tracks real time', () => {
  const D0 = 5 * 60 * 1000; // 5 minutes already banked before this resume
  const autosaveEveryMs = 5000;
  const cycles = 12; // 1 simulated minute of resumed recording

  let oldBaseline = D0;
  let oldFinal = D0;
  let fixedFinal = D0;
  for (let i = 1; i <= cycles; i += 1) {
    const raw = i * autosaveEveryMs; // live recorder elapsed since resume, never reset
    oldFinal = oldBaseline + raw;
    oldBaseline = oldFinal; // the bug: each autosave writes the combined value back as the new baseline
    fixedFinal = D0 + raw; // the fix: baseline never changes after mount
  }

  const realElapsedMs = D0 + cycles * autosaveEveryMs; // what the true elapsed time actually is
  assert.equal(fixedFinal, realElapsedMs, 'fixed formula must equal true elapsed time exactly');
  assert.ok(
    oldFinal > realElapsedMs * 1.5,
    `old formula must blow past real elapsed time within just 1 simulated minute (got old=${oldFinal}ms vs real=${realElapsedMs}ms)`,
  );

  // Extend to a full simulated hour to show the growth is superlinear (compounds
  // faster than real time), not just a fixed one-time offset — matching the
  // owner's report of a ~60min class reading as ~345min.
  const hourCycles = 60 * (60000 / autosaveEveryMs);
  let hourBaseline = D0;
  let hourOldFinal = D0;
  for (let i = 1; i <= hourCycles; i += 1) {
    const raw = i * autosaveEveryMs;
    hourOldFinal = hourBaseline + raw;
    hourBaseline = hourOldFinal;
  }
  const hourRealElapsedMs = D0 + hourCycles * autosaveEveryMs;
  assert.ok(
    hourOldFinal > hourRealElapsedMs * 5,
    `over a full simulated hour the old formula must compound far past a modest offset (got old=${hourOldFinal}ms vs real=${hourRealElapsedMs}ms)`,
  );
});

console.log(`\nrecording-session-duration: ${passed} checks passed`);
