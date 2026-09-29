# RC-1 provenance manifest (Dev RC, bundle `com.aydenz.youmilensipad.dev`)

Base: `eb79b71` (v0.2.1, build 56). Branch `release/rc-integration`.
Version / build number / App Store metadata: **unchanged** (0.2.1 / 56).
Recording engine: **legacy** (unchanged). Backend: **not deployed, not modified**.

## Group 1 — No-speech client convergence
- SOURCE WORKTREE: `/Users/summer/Documents/youmi-lens-ipad-integrated-physical-validation`
- SOURCE COMMIT: UNCOMMITTED source (dirty worktree on `eb79b71`)
- SOURCE FILES: `lib/processingResume.mjs`, `scripts/processing-resume.test.mjs`
- TRANSFERRED FILES: `lib/processingResume.mjs`, `scripts/processing-resume.test.mjs`, new `scripts/processing-status-no-speech-ready.test.mjs`
- ACCEPTANCE EVIDENCE: accepted production no-speech behavior (explicit AI `done` + `transcript === ''` => Ready before language/content gates); owner Decision 4.
- FOCUSED TESTS: `processing-resume`, `processing-status-no-speech-ready` (done+empty=>Ready, no Ready<->Processing flicker, incomplete job not falsely Ready, poll stops, store `processingStatusFromRemote` agreement)
- RC COMMIT: `c6942d9`

## Group 2 — Course-scoped recovery
- SOURCE WORKTREE: `/Users/summer/Documents/youmi-lens-ipad` (main, dirty)
- SOURCE COMMIT: UNCOMMITTED source (main @ `0956799` + working tree)
- SOURCE FILES: `lib/recording/policy.mjs`, `lib/recording/useUnresolvedRecordingGuard.ts`, `app/recording.tsx`, locales, tests
- TRANSFERRED FILES: `classifyUnresolvedSessions` + `courseScopedUnresolvedSessions` verbatim (policy.mjs); guard + recording screen adapted onto the integrated line's stricter exact-ID ownership (`ownedUnresolvedRecoverableSessions`) rather than overwritten; 3 locale keys x 6 locales; `course-scoped-recovery`, `checkpoint-rollover-identity-safety` tests
- ACCEPTANCE EVIDENCE: owner Decision 2(A); accepted user-facing fix (unrelated-course sessions must not block Start New Recording)
- FOCUSED TESTS: `course-scoped-recovery` (20), `checkpoint-rollover-identity-safety` (28)
- RC COMMIT: `3c4f342`

## Group 3 — Course restore-on-commit + deletion-race safety
- SOURCE WORKTREE: `/Users/summer/Documents/youmi-lens-ipad` (main, dirty)
- SOURCE COMMIT: UNCOMMITTED source
- SOURCE FILES: `lib/courseRestoreOnCommit.mjs`, `lib/deletionSync.mjs`, `lib/store.tsx`, tests
- TRANSFERRED FILES: `lib/courseRestoreOnCommit.mjs` (verbatim), `resolveCourseDeletionState` (pure insertion in `deletionSync.mjs`), store wiring (`courseRestoreFixups`, `restoreCourseIfDeletedForNewCommit` in `createLecture`/`saveInProgressLecture`), tests `course-restore-on-commit`, `course-deletion-race`, updated `legacy-ghost-course-derivation`. No `courseDeleteDiagnostics`.
- ACCEPTANCE EVIDENCE: owner Decision 2(B)
- FOCUSED TESTS: `course-restore-on-commit`, `course-deletion-race`, `legacy-ghost-course-derivation`
- RC COMMITS: `b56f8fc`, `90be5da`

## RC-1.1 — lint-neutral cleanup
- Commit `fix: keep RC course restore integration lint-neutral` (single commit after the provenance commit; touches only `lib/store.tsx` + this doc). `restoreCourseIfDeletedForNewCommit` moved from an in-provider `useCallback` to a module-level function taking `(courseId, courses, setCourses, currentUserId)`; `createLecture`/`saveInProgressLecture` deps are `[currentUserId]` (previously the callback's own deps were `[currentUserId]`, so identity behavior is unchanged). Course restore/deletion semantics unchanged; focused course tests, full suite (same 3 baseline failures), tsc, diff-check pass.

## RC-1.2 — Course Material finger handle editing parity
- Commit `fix: align Course Material finger shape editing with Notebook` (after the RC-1.1 cleanup commit).
- ROOT CAUSE: shared router `routeSelectionTouch` knew `shape-handle-edit` only for the Pencil. Notebook compensated locally (`beginShapeHandleEdit` before the body move); Course Material's native one-finger recogniser went scale -> `beginMoveIfHit`, and a handle lies inside the padded body bounds, so the body move swallowed the finger and `beginHandleDragIfHit` was reachable only from the Pencil recognisers.
- FIX: router gets the finger-on-handle branch (handle > body move > page; two fingers still scale); Notebook passes `onHandle` into the router (same behavior); native `AnnotationOverlay.beginFingerManipulation` (scale -> handle -> move) is what the finger recogniser calls, with a `.handle` mode (live native preview, ONE `onShapeEdited` on release). Recognition, Shape Snap, geometry, hit radii, toolbar, Pencil paths: unchanged.
- TESTS: new `selection-finger-handle-parity`; native fixture `NATIVE_FINGER_HANDLE_PASS` at 0.5x/1x/2x + rotated page; router cases in `selection-transform`; updated Notebook routing contracts and the shape-edit emit-site count (2 -> 3).

## Group 4 — Other explicitly authorized fixes
- Other-account lecture lookup: **EXCLUDED** — not proven required by an accepted user-facing fix (integrated line's exact-ID ownership is stricter).
- Legacy recorder health/watchdog: **EXCLUDED — STOPPED FOR REVIEW**. It changes recording lifecycle behavior materially (Decision 2(D) STOP clause). Inclusion would not be a Recording Release PASS.
- Diagnostics (`devNetworkTrace`, `courseDeleteDiagnostics`): **EXCLUDED**.
- `processingCompleteness`: **EXCLUDED** (conflicts with accepted no-speech semantic; untouched in source worktree).
- Other main commits not authorized and not integrated: `97cd4c7`, `be299f8`, `0140283`, `2b42d7c`, `6240101`, `36b2d97`, `ccc2139`, `6dd72ec`, `637b368`; `holdForGuard`; native checkpoint interval 60->5.
- RC COMMIT: none.

## Group 5 — Annotation/Shape final physically accepted manifest
- SOURCE WORKTREE: `/private/tmp/claude-501/pk4b1-wt`
- SOURCE COMMIT: UNCOMMITTED source on `eb79b71`
- SOURCE FILES / TRANSFERRED FILES: 93 files copied byte-identically (hash-verified) + deletion of `components/MaterialFloatingToolbar.tsx` (94 path entries). Shared toolbar, Notebook + Course Material adapters, structured shapes, Shape Snap, selection state machine (TS + Swift), finger move / two-finger scale, pen-mode direct tap, PK4-C3 write gate, dev-gated traces, native selection fixtures.
- EXCLUDED: Natural Pen experiments, PDF export investigation, stale intermediate Shape implementations, unrelated dirty files.
- ACCEPTANCE EVIDENCE: owner physical passes (PK4-B1, PK4-C3, finger move/scale, persistent shape selection, pen-mode direct tap, triangle/quad/ellipse handles). Frozen; not retuned.
- FOCUSED TESTS: shared-toolbar-chrome, notebook-shared-toolbar-adapter, course-material-*, selection-machine (+ TS/Swift parity), selection-transform, selection-interaction-integration, pen-tap-select, shape-snap*, structured-shape-integration, annotation-shape, material-selection-history, material-ink-prop-gate, native fixtures (`material-native-selection`: NATIVE_SELECTION_FIXTURE_PASS, NATIVE_ELLIPSE_HANDLES_PASS, NATIVE_PEN_TAP_ROTATED_PASS)
- RC COMMIT: `62e8836`
- Dev-only gating audit: selection/shape-snap traces gated on the `.dev` bundle id; native `InkPerfRecorder` gated on `.dev` suffix; embedded PencilKit test surface and "DEV - Apple Pen Test" button gated on `PENCILKIT_TEST_DEV_ENABLED` (bundle id). The `expo-pencilkit-test` native module autolinks into production binaries but is never mounted outside the Dev bundle (JS-gated). Reported, not changed.

## Group 6 — Payment hardening
- SOURCE WORKTREE: payment-hardening worktree
- SOURCE COMMIT: `b02523c847d2f4b2f4d949c7aa28f6290297fea2`
- TRANSFERRED FILES: 16 files (cherry-pick -x): `lib/subscriptions.ts`, `lib/boundedPaymentTask.ts`, `lib/boundedTask.ts`, `lib/iapDiag.ts`, `app/plans.tsx`, `app/(tabs)/settings.tsx`, `docs/payment-phase1.md`, `package.json` (+`test:payment`), tests, harness
- ACCEPTANCE EVIDENCE: owner Decision 6; `SUBSCRIPTION_PRODUCT_IDS` definition byte-identical to base; no price/tier/quota/entitlement lines changed (diff grep empty); backend verification calls preserved (bounded-wait wrapping only)
- FOCUSED TESTS: `npm run test:payment` — 132 pass / 0 fail
- RC COMMIT: `7b01e74`

## Gate results (from Documents-located RC worktree)
- Full JS suite: 181 pass / 3 fail of 184 — the 3 are the true eb79b71 baseline failures with identical signatures (`cloud-sync-canonical-course-id`, `lecture-session-resume-playback`, `recording-caption-pause-resume`); no new regression.
- `tsc --noEmit`: 0 errors. `git diff --check`: clean.
- ESLint: RC-1.1 = 80 errors / 49 warnings vs pristine baseline 80 / 41 — zero new errors in any file. (RC-1 initially had 81: the group-3 `restoreCourseIfDeletedForNewCommit` was a `useCallback` after the provider's early return; RC-1.1 made it a module-level function with identical semantics.) +8 warnings are in accepted new files (4 `no-require-imports`, 4 `no-unused-vars` in tests).
- Backend vitest (read-only, `/Users/summer/Documents/youmi-lens`): 844 pass / 4 fail (missing `stripe` package in that checkout; title-guard and staging-launcher tests against the backend's own uncommitted state). Backend repo unmodified.

## BACKEND SOURCE/DEPLOYMENT REPRODUCIBILITY DEBT (OPEN)
Backend `/Users/summer/Documents/youmi-lens` HEAD `3ef790e`, 28 dirty entries; `server/processRecording.mjs` has +99 uncommitted lines (`markDoneEmptyNoSpeech`). Accepted production behavior includes no-speech handling that exists in source only as uncommitted work. Evidence: `docs`-external artifacts `rc-1/backend-evidence/`. No deployment, Railway change or env change performed.
