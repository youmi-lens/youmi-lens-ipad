# Apple Pencil / Notebook handwriting audit

Date: 2026-07-19  
Scope: Notebook handwriting responsiveness (React Native path)  
Physical iPad: not used  
TestFlight: not created  
Recorder: unchanged (`CONFIGURED_RECORDING_ENGINE = 'legacy'`)

## 1. Current Notebook architecture

Entry points:

- `app/lecture/[id].tsx` — lecture notes editor hosts `NotebookCanvas`
- `app/mini-caption.tsx` — live caption + notebook hosts `NotebookCanvas`
- `components/NotebookCanvas.tsx` — primary handwriting UI (~4.7k lines)

Stack (verified):

- React Native + Expo
- `react-native-gesture-handler` (`Gesture.Pan`, `PointerType.STYLUS`, `runOnJS(true)`)
- `react-native-svg` (`Path` / `Circle` stroke rendering)
- Optional `expo-pencil-interaction` — Apple Pencil **double-tap only** (`lib/pencilInteraction.ts`)
- Stroke model: `NoteStroke` / `NotePoint` in `lib/models.ts`
- Persistence: parent callbacks (`onStrokesChange`) into lecture store; no per-point storage writes in the canvas

Separate path (not the Notebook paper):

- Native PDFKit annotation: `modules/expo-pdf-annotation` + `NativePdfAnnotationView`
- JS fallback overlay: `components/MaterialAnnotationOverlay.tsx`

## 2. Exact tool set

From `PRIMARY_TOOLS` + chrome in `NotebookCanvas.tsx`:

| Tool key | UI label | Role |
| --- | --- | --- |
| `write` | Write / Pen | Stylus ink |
| `highlight` | Highlight | Stylus highlighter |
| `type` | Text | Typed notes layer |
| `select` | Select | Lasso / rect select + move |
| `insert` | Insert | Photos |
| `erase` | Erase | Whole-stroke eraser |
| `scroll` | Hand | Finger/page scroll mode |
| (chrome) | Minimize | Collapse toolbar |
| (chrome) | Undo / Redo | Fixed history control when enabled |
| (chrome) | Clear / Delete | Trash / delete selection |
| (chrome) | Duplicate | Selected image duplicate |

Finger drawing is intentionally disabled in write/erase: only `PointerType.STYLUS` activates ink; fingers scroll.

## 3. Input-to-render pipeline

```
Apple Pencil / stylus touch
  → RNGH Pan (manualActivation) on GestureScrollView
  → onTouchesDown / Move / Up (JS thread via runOnJS)
  → coordinate = touch.x/y + scrollOffsetY
  → distance filter (MIN_POINT_DISTANCE = 1.8)
  → ActiveInkHost ref (in-place point append + local React revision)
  → SVG Path via strokeToPath (active layer only)
  → on pointer up: commitStroke → clone points → onStrokesChange([...strokes, stroke])
  → recordHistory snapshot (bounded undo)
  → parent persists lecture notes (outside per-point path)
```

| Stage | File / symbol | Thread | Per point? | React setState? | Parent canvas rerender? | Completed strokes rerender? | Path regen all strokes? | Array copy? | History / JSON / storage? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gesture | `drawGesture` | JS | yes | no (ink) | no (ink) | no | no | no | no |
| Filter / append | `ActiveInkHost.append` + `appendStrokePoint` | JS | yes | yes (host only) | no | no | active only | in-place push | no |
| Active SVG | `StrokeShape` in `ActiveInkHost` | JS→native SVG | yes | host | no | no | active only | n/a | no |
| Commit | `commitStroke` | JS | stroke end | parent via props | once | once | once for new stroke | copy points on commit | history snapshot once |
| Persist | parent / store | JS | deferred | parent | n/a | n/a | n/a | full doc as designed | on parent save path, not per point |

## 4. Stroke data model

`NotePoint`: `{ x, y }` only (no pressure / tilt fields).

`NoteStroke`: `{ id, tool?, color, width, opacity?, points, createdAt }`.

Path representation: SVG `d` string from `strokeToPath` (quadratic midpoints); not stored — rebuilt for render / PDF export.

Undo: full `{ strokes, images, text }` snapshots, max 60 (`HISTORY_MAX`).

Active vs completed: separated after this change (`ActiveInkHost` vs `CompletedStrokeLayer`).

Empty / single-point: empty path `''`; single point renders as `Circle` / tiny segment path helper.

## 5. Pencil data availability

| Capability | Classification |
| --- | --- |
| Pressure / force | Unavailable through current Notebook model (not stored); RNGH may expose stylus metadata elsewhere but Notebook discards |
| Altitude / azimuth / tilt | Available on some events in Material overlay heuristics; **discarded** in Notebook ink |
| Coalesced touches | Unavailable through current JS gesture path |
| Predicted touches | Unavailable through current JS gesture path |
| Hover | Unavailable / unused |
| Double tap | Available and used (`expo-pencil-interaction` → Write ↔ Eraser) |
| Squeeze | Native-only / unused |
| Palm rejection | Partial product behavior: multi-touch ignored while stroke live; non-stylus fails activation in write/erase |
| Pencil vs finger | Available and used (`PointerType.STYLUS`) |
| Primary vs secondary | Irrelevant / unused |

No new Pencil features (hover, squeeze, tilt drawing) were added in this phase.

## 6. Baseline measurements

### Static architecture findings (pre-change)

Proven:

1. **Every accepted point called `setCurrentPoints([...pts, point])` on `NotebookCanvas`**, forcing a full parent re-render (toolbar, paper chrome, overlays).
2. **Completed strokes lived in the same parent render** as live points. `StrokeShape` was not memoized; each parent commit re-invoked `strokeToPath` for **every** visible stroke.
3. Structural cost: path builds per point ≈ `completedStrokeCount + 1` (see `pathBuildsPerActivePoint`).

### Simulator runtime findings

Not claimed as physical Pencil latency. No Instruments session in this pass. Structural model + pure stress helpers only.

### Physical Pencil questions remaining

- Event-to-pixel latency with real Apple Pencil
- Coalesced / predicted touch benefit
- Palm / hover edge cases on device
- Subjective “ink follows tip” feel

## 7. Render findings

Before: parent + all `StrokeShape` path rebuilds per point.  
After: only `ActiveInkHost` revises per point; `CompletedStrokeLayer` memoized; `StrokeShape` memoized for stable completed stroke props.

## 8. State-update findings

Before: O(n) points array copy + parent `useState` per point.  
After: in-place `appendStrokePoint` in ActiveInk ref; revision counter local to ActiveInkHost; parent updates on stroke begin (`stylusStrokeActive`) and commit only.

## 9. Persistence and history findings

- Save via parent on stroke end / lecture save — **not** during active samples
- Undo snapshots whole document content (strokes+images+text), bounded to 60
- Active strokes do not enter history until commit
- No persistence redesign performed

## 10. Proven bottlenecks

| ID | Class | Evidence |
| --- | --- | --- |
| B1 | B State/data | Full parent state + array copy per point (code path) |
| C1 | C Rendering | All completed SVG paths regenerated per point (unmemoized `StrokeShape` + shared parent) |
| A1 | A Input | Coalesced/predicted touches unavailable in JS path — **not proven dominant**; deferred to physical test |
| D1 | D Persistence | No per-point writes found |
| F1 | F Native limit | Gate **not** met for prototype; RN path still improvable and now improved |

## 11. RN optimizations evaluated

| Candidate | Verdict |
| --- | --- |
| Active points in ref + isolated host | **Retained** |
| Separate completed / active layers | **Retained** |
| Memoize `StrokeShape` | **Retained** |
| In-place append (no per-point full copy) | **Retained** |
| Incremental SVG path string | Deferred (active path rebuild is O(active points) only; acceptable) |
| rAF batching | Deferred (isolation already removes parent work) |
| Native prototype | **Not created** (gate not met) |
| PencilKit rewrite | **Not started** |

## 12. RN optimizations retained

1. `lib/notebookStroke.ts` — pure path/filter helpers + cost model  
2. `ActiveInkHost` — live ink state isolation  
3. `CompletedStrokeLayer` — memoized completed + selection chrome  
4. `memo(StrokeShape)`  
5. Commit copies points for immutability  

## 13. Before/after evidence

Synthetic structural model (`npm run test:notebook`):

| Completed strokes | Path builds / point before | After |
| ---: | ---: | ---: |
| 0 | 1 | 1 |
| 100 | 101 | 1 |
| 500 | 501 | 1 |

This is **not** a physical millisecond claim.

## 14. Native prototype decision

**Do not create a native prototype now.**

Reasons:

- Dominant proven issue was React state/render coupling, addressable in RN
- Input coalescing/prediction not yet shown as the binding constraint on Simulator
- PencilKit / native overlay remains a future option after physical dogfood

## 15. PencilKit tradeoffs

Pros: low-latency ink, coalesced/predicted touches, palm rejection, pressure.  
Cons: `PKDrawing` vs `NoteStroke` dual models; custom highlight/eraser/select/text/images/undo/export parity; migration; Android/web story.

Recommendation: keep RN document ownership; reconsider PencilKit **only for active ink** after physical measurements if RN path still fails feel targets.

## 16. PDF annotation comparison

- Native: PDFKit + Pencil-only `UIGestureRecognizer` (`allowedTouchTypes = [.pencil]`), overlay renders strokes in page coordinates
- Notebook: RNGH + SVG in view coordinates
- Should remain separate: different coordinate spaces and document models
- Shared stroke **ideas** (stylus-only, overlay render) inspired RN ActiveInk isolation; full shared model not realistic without migration

## 17. Stress-test results

Automated pure tests:

- T1 long stroke (2000 pts): path builds successfully  
- T2/T4 filtering: near-duplicates dropped, distinct samples kept  
- T3: structural 100/500 density cost table (above); full UI 500-stroke Simulator memory not instrumented  
- T5–T7: not run as UI automation; undo/history code path unchanged except commit immutability copy  

## 18. Release-safety audit

No new `__DEV__` hosts, flags, deep links, or native DEBUG APIs added.  
No production navigation entries.  
Profiler logs not committed.

## 19. Simulator limitations

Simulator cannot validate Apple Pencil tip latency, coalesced samples, or palm rejection. Do not treat this audit as production Pencil readiness.

## 20. Future physical Pencil checklist

### P1 — Normal handwriting

- Prerequisites: development or TestFlight build on physical iPad + Pencil  
- Steps: slow / normal / fast writing; small letters; curves; lines  
- Expected: ink follows tip without obvious lag or harmful stepping; final point present  
- Evidence: screen recording  
- PASS / FAIL / stop: obvious lag, jumps, missing tip → FAIL; crash → stop

### P2 — Long continuous stroke

- Steps: long line, zigzag, circle, spiral  
- PASS: no freeze, no broken path, no large delay after lift

### P3 — Dense page (≥100 strokes)

- Steps: add, erase, select, undo, pan  
- PASS: usable; no severe slowdown; no crash

### P4 — Pressure and tilt

- Only if product adds support later; currently N/A for width-from-pressure

### P5 — Palm behavior

- Rest/move palm while writing; finger scroll  
- PASS: no accidental marks; Pencil primary in write mode

### P6 — Tool switching

- Rapid Pen / Highlight / Eraser / Hand / Select  
- PASS: no stale gesture; correct tool state

## 21. Final recommendation

Ship the retained RN ActiveInk isolation, then run the physical checklist on a dedicated build. Do **not** start a PencilKit rewrite until physical evidence shows remaining gap.

## 22. Readiness classification

**RN PATH ACCEPTABLE**

Meaning: severe structural per-point completed-stroke rebuild is removed; RN path is suitable for later physical testing. Not a claim of production Pencil feel.

## 23. Production recorder confirmation

- `CONFIGURED_RECORDING_ENGINE` remains `'legacy'`
- Durable recorder R1–R6 not modified
- Recorder R7 not started
- No TestFlight build
- No physical iPad used in this workstream
