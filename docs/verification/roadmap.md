# Native recording roadmap

Forward plan only — none of this is implemented. Phases 1–2C are complete and
committed; native recording remains gated off by default.

## Completed

| Phase | Outcome | Commit |
| --- | --- | --- |
| 1 | Native contract and foundation freeze | `7d39deb` |
| 2A | Durable native session layer | `b8d53dc` |
| 2B | Durable foreground audio engine, segments, pause/resume | `0c57581` |
| 2C | Feature-gated adapter, recovery, discard, handoff | `e3af1e7` |
| 3 | Controlled dogfooding: runtime selection policy, fallback reasons, provenance, privacy-minimal diagnostics | `f3e4ec7` |
| 4 | Reversible per-user rollout control, kill switch, engine freeze, recovery precedence (backend undeployed) | see `phase-4-rollout-control.md` |

## Phase 3 — delivered

Runtime selection policy, build-time internal cohort eligibility, deterministic
fallback reason codes, local engine provenance, and privacy-minimal console
diagnostics. Default remains legacy. Details in `phase-3-dogfood.md`.

**Deferred out of Phase 3:**

- ~~Per-user remote eligibility~~ — delivered in Phase 4 (client complete;
  backend migration prepared but not deployed).
- Physical resume-from-recovery and discard gates.
- Recovery UX polish: the recovery card still blocks starting a new recording,
  which is safe but blunt. Revisit once real recovery frequency is known.

## Phase 4 — delivered

Reversible per-user rollout control: strict remote config parsing, user-scoped
cache with a 15-minute TTL, kill switch, active-session engine freeze, and
recovery precedence over rollout state. Client is complete and tested; the
Supabase migration is prepared, RLS-reviewed, and **not deployed**. Details in
`phase-4-rollout-control.md`.

## Phase 5 — native recording becomes the default

Entry criteria, all required:

- Physical gates passed on at least two device classes
- Dogfooding with zero unexplained reconciliation issues
- Telemetry showing recovery succeeds when offered
- A tested rollback path back to legacy

The flip itself is one line in `featureGate.ts`. Keep the legacy recorder in the
tree for at least one full release after the default changes.

## Background recording

The largest remaining capability gap, and the reason a mid-capture kill still
loses the active segment.

- Requires the `audio` background mode, which changes App Store review posture
- Needs periodic segment rollover so an unexpected kill loses seconds, not
  minutes
- Needs explicit interruption policy for calls and Siri
- Should not begin until Phase 4 is stable — it multiplies the state space

## Crash recovery improvements

- **Salvage partial segments.** A `.partial.m4a` is currently unrecoverable. A
  periodic `moov` flush, or remuxing from raw AAC frames, would turn today's
  loss into a partial save. This is the single highest-value durability
  improvement available.
- Distinguish "app was killed" from "device rebooted" for clearer recovery copy.
- Automatic reconciliation for `orphan_finalized_file` — valid audio on disk not
  referenced by metadata is currently reported but never re-attached.

## Apple Pencil and notebook work

Independent of recording; sequence after Phase 4 to avoid competing for the same
screens.

- Native ink capture for lower latency than the current React Native path
- Durable stroke persistence modelled on the segment approach: append-only,
  atomic metadata, immutable committed units
- Notebook and recording currently share autosave in `app/recording.tsx`;
  separate them before either grows further

## Standing constraints

- Recording must never be lost — prefer an extra prompt over silent loss
- Segments stay immutable; resume appends
- Handoff stays at-least-once, ordered create-then-acknowledge
- The committed feature gate stays `legacy` until Phase 4 formally lands
- No recording audio or content in telemetry
