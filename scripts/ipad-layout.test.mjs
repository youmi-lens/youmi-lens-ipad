import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const home = read('../app/(tabs)/index.tsx');
const settings = read('../app/(tabs)/settings.tsx');
const responsive = read('../constants/responsive.ts');
const tutorial = read('../components/tutorialTour/simulatedScreens.tsx');
const tutorialShell = read('../components/tutorialTour/TutorialAppShell.tsx');
const tutorialOverlay = read('../components/TutorialTourOverlay.tsx');
const notebook = read('../app/mini-caption.tsx');

assert.match(responsive, /COMPACT_WIDTH_BREAKPOINT = 900/);
assert.match(home, /const isTabletCompact = isPad && isCompact/);
assert.match(home, /scrollTabletCompact/);
assert.match(home, /emptyGridTabletCompact/);
// Release A note: this was a stale test, not a product bug. `git log -p`
// confirms the layout was deliberately changed from
// `{ minHeight: 650, justifyContent: 'space-between', ... }` to
// `{ gap: 24, paddingBottom: 12 }` — the prior fixed-height/space-between
// layout left a portrait-iPad empty state reading as an accidental hole
// between two cramped cards rather than deliberate negative space. That
// change already shipped (an ancestor of this release's own baseline); only
// this assertion was never updated to match it.
assert.match(home, /emptyGridTabletCompact: \{ gap: 24, paddingBottom: 12 \}/);
assert.match(settings, /isCompact \? styles\.gridCompact : styles\.gridWide/);
assert.match(settings, /gridWide: \{ gap: 24 \}/);
assert.match(settings, /column: \{ gap: 16 \}/);
assert.match(settings, /isCompact \? styles\.columnCompact : styles\.primaryColumn/);
assert.match(settings, /isCompact \? styles\.columnCompact : styles\.secondaryColumn/);
assert.match(settings, /primaryColumn: \{ width: 340, minWidth: 340, maxWidth: 340, gap: 20 \}/);
assert.match(settings, /secondaryColumn: \{ flexGrow: 1, flexShrink: 1, flexBasis: 0, width: 0, minWidth: 0, gap: 20 \}/);
assert.match(settings, /columnCompact: \{ width: '100%', minWidth: 0, gap: 16 \}/);
assert.match(settings, /style=\{!isCompact \? styles\.accountCardWide : undefined\}/);
assert.match(settings, /accountCardWide: \{ width: 340, maxWidth: '100%', alignSelf: 'stretch' \}/);
assert.match(settings, /roomy=\{!isCompact\}/);
assert.match(settings, /profileWide: \{ gap: 15, paddingHorizontal: 24, paddingVertical: 24 \}/);
assert.match(settings, /settingRowRoomy: \{ minHeight: 82, gap: 14, paddingHorizontal: 24, paddingVertical: 16 \}/);
assert.match(settings, /profileText: \{ flex: 1, minWidth: 0 \}/);
assert.match(settings, /settingText: \{ flex: 1, minWidth: 0 \}/);
assert.match(tutorial, /useIsCompactWidth/);
assert.match(tutorial, /iPad Pro 11" is 834pt in\s*\*\s*portrait/);
assert.match(tutorialShell, /stage: \{ flex: 1, minHeight: 0 \}/);
assert.match(tutorialShell, /wideBody: \{ flex: 1, minWidth: 0, minHeight: 0 \}/);
assert.match(tutorialOverlay, /flex: 1, minHeight: 0/);
assert.match(notebook, /useWindowDimensions/);

console.log('iPad layout composition guards passed.');
