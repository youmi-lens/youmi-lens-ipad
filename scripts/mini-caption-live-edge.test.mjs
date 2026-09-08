/**
 * Caption popup (Mini Workspace's floating caption panel, app/mini-caption.tsx)
 * must always open showing the LIVE EDGE during active recording — the owner
 * reported it sometimes reopening near the top, mid-history, or at a stale
 * scroll position instead, forcing a manual scroll to catch up during class.
 *
 * Root cause: the panel (including its ScrollView, `feedScrollRef`) is
 * conditionally rendered — `setPanelVisible(false)` ("hide captions", collapse
 * to the listening pill) fully unmounts it, and `setPanelVisible(true)`
 * ("show captions") mounts a brand-new ScrollView instance, which naturally
 * starts scrolled to the top. `autoFollowFeed` is PARENT-level state that
 * survives that unmount. If the user had scrolled up to read caption history
 * before minimizing, `autoFollowFeed` stayed false, and the pre-existing
 * scroll-to-live effect (gated on `if (!autoFollowFeed) return`) never told
 * the freshly-mounted ScrollView to catch up — it just sat at the top.
 *
 * These are structural source-level guards (this is a draggable/resizable
 * native RN component; feel can only be judged on a real device — see the
 * task's own runtime-validation note) plus pure state-machine simulations of
 * the parts that ARE testable without React Native.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const src = read('../app/mini-caption.tsx');

console.log('1. Fresh open requests the live edge');
check('autoFollowFeed defaults to true on mount', () => {
  assert.match(src, /const \[autoFollowFeed, setAutoFollowFeed\] = useState\(true\);/);
});

console.log('\n7. Close (minimize) -> reopen during the SAME active recording resets to live edge (the fix)');
check('the panel is conditionally rendered — closing genuinely unmounts the ScrollView, not just hides it', () => {
  assert.match(src, /\{!panelVisible \? \(/, 'the listening pill only renders while the panel is hidden');
  assert.match(src, /\{panelVisible \? \(/, 'the full panel (and its ScrollView) is only rendered while visible — a real unmount, not CSS visibility');
});

check('a panelVisible false->true transition force-resets autoFollowFeed to true', () => {
  const fixBlock = src.slice(
    src.indexOf('const wasPanelVisibleRef = useRef(panelVisible);'),
    src.indexOf('useEffect(() => {\n    if (!showCaptionFeed)'),
  );
  assert.match(fixBlock, /const wasPanelVisibleRef = useRef\(panelVisible\);/);
  assert.match(fixBlock, /if \(panelVisible && !wasPanelVisibleRef\.current\)/, 'must detect the false->true (reopen) transition specifically');
  assert.match(fixBlock, /setAutoFollowFeed\(true\)/);
  assert.match(fixBlock, /wasPanelVisibleRef\.current = panelVisible;/, 'must track the transition every render, not just once');
});

check('the reopen-reset effect is keyed on panelVisible so it re-runs on every open/close cycle', () => {
  const refIndex = src.indexOf('const wasPanelVisibleRef = useRef(panelVisible);');
  const effectDecl = src.slice(refIndex, refIndex + 300);
  assert.match(effectDecl, /\}, \[panelVisible\]\);/);
});

console.log('\nNumeric proof: reopening while reading history now lands at the live edge, not where it was left');

/**
 * Replays the two effects' actual guard conditions across a
 * close-while-reading-history -> reopen sequence, once with the fix and once
 * without, to prove the fix is what closes the gap.
 */
function simulateReopen(withFix) {
  let autoFollowFeed = true;
  let wasPanelVisible = true;

  // User scrolls up to read history while the panel is open.
  const distanceFromBottom = 900; // far from the 72px live-edge threshold
  autoFollowFeed = distanceFromBottom < 72;
  assert.equal(autoFollowFeed, false, 'reading history disables auto-follow, as designed');

  // User taps "hide captions" (minimize to the listening pill).
  const panelVisible = false;
  // (the reopen-reset effect only acts on a false->true transition, so this
  // run is a no-op for it)
  wasPanelVisible = panelVisible;

  // User taps the listening pill to reopen the panel (setPanelVisible(true)).
  const reopened = true;
  if (withFix && reopened && !wasPanelVisible) {
    autoFollowFeed = true; // the fix: force back to live edge on reopen
  }
  wasPanelVisible = reopened;

  // Whether the freshly-mounted ScrollView gets told to scroll to the live edge.
  const scrollsToLiveEdgeOnMount = autoFollowFeed;
  return scrollsToLiveEdgeOnMount;
}

check('WITHOUT the fix, reopening after reading history would leave the fresh ScrollView at the top (the reported bug)', () => {
  assert.equal(simulateReopen(/* withFix */ false), false);
});

check('WITH the fix, reopening after reading history lands at the live edge every time', () => {
  assert.equal(simulateReopen(/* withFix */ true), true);
});

console.log('\n4/6. Manual scroll away disables auto-follow; returning near the bottom resumes it');
check('updateAutoFollowFromScroll uses a small, fixed live-edge threshold, not an exact-bottom requirement', () => {
  assert.match(src, /const updateAutoFollowFromScroll = \(scrollY: number\) => \{/);
  assert.match(src, /const distanceFromBottom = contentHeight - layoutHeight - scrollY;/);
  assert.match(src, /setAutoFollowFeed\(distanceFromBottom < 72\);/);
});
check('threshold math: far from bottom -> follow off, near bottom -> follow on', () => {
  const isFollowing = (contentHeight, layoutHeight, scrollY) =>
    contentHeight - layoutHeight - scrollY < 72;
  assert.equal(isFollowing(5000, 400, 0), false, 'scrolled to the very top of a long history: not following');
  assert.equal(isFollowing(5000, 400, 4000), false, '600px from the bottom: still reading history, not following');
  assert.equal(isFollowing(5000, 400, 4600), true, 'within 72px of the true bottom: following resumes');
});

console.log('\n5. New captions never yank the reading user back down');
check('the scroll-to-live effect is gated on autoFollowFeed and returns early when the user is reading history', () => {
  const effect = src.slice(src.indexOf("useEffect(() => {\n    if (!showCaptionFeed)"), src.indexOf('const updateAutoFollowFromScroll'));
  assert.match(effect, /if \(!autoFollowFeed\) return;/);
});

console.log('\n8. The current partial/live caption stays visible in live mode');
check('the live line is appended as the LAST feed item, so scrollToEnd always reveals it', () => {
  assert.match(src, /const activeFeedLine = currentActiveEnglish/);
  assert.match(src, /\.\.\.\(activeFeedLine \? \[activeFeedLine\] : \[\]\),\s*\n\s*\];/);
});
check('the scroll-to-live effect re-runs on every partial-caption token while following, keeping the live line pinned in view', () => {
  const effectStart = src.indexOf("if (!showCaptionFeed) {");
  const effectEnd = src.indexOf('updateAutoFollowFromScroll', effectStart);
  const effectBlock = src.slice(effectStart, effectEnd);
  assert.match(effectBlock, /partialCaption,/, 'partialCaption must be a dependency so the live line keeps scrolling into view as it updates');
});

console.log('\n9. The earlier caption-render performance fix (a separate file) is untouched');
check('lib/liveCaptions.tsx still scopes finalCaptions/latestFinalLine to captionLines only (not reintroduced/regressed by this change)', () => {
  const liveCaptions = read('../lib/liveCaptions.tsx');
  assert.match(liveCaptions, /const finalCaptions = useMemo\(\(\) => captionLines\.map\(\(line\) => line\.text\), \[captionLines\]\);/);
});
check('components/CaptionHistoryFeed.tsx is still memoized', () => {
  const feed = read('../components/CaptionHistoryFeed.tsx');
  assert.match(feed, /export const CaptionHistoryFeed = memo\(/);
});
check('mini-caption.tsx does not import CaptionHistoryFeed — this fix stayed scoped to the Mini panel\'s own feed, no cross-file coupling introduced', () => {
  assert.doesNotMatch(src, /CaptionHistoryFeed/);
});

console.log(`\nmini-caption-live-edge: ${passed} checks passed`);
