# Recording verification

Durable native recording — how it works, how it is verified, and what still
needs a human.

## Commands

| Command | When |
| --- | --- |
| `npm run test:recording` | Any change touching recording (~7s, no device) |
| `npm run release:recording` | Before a release — full suite plus simulator build |
| `npm run release:recording:fast` | Same, skipping the simulator build |

## Documents

| Document | Contents |
| --- | --- |
| [recovery-architecture.md](recovery-architecture.md) | Storage layout, session lifecycle, recovery, handoff, idempotency |
| [native-recording-test-guide.md](native-recording-test-guide.md) | Expected states, files, metadata, failure signatures |
| [release-checklist.md](release-checklist.md) | Dev vs release workflow, and the one manual RELEASE-ONLY gate |
| [phase-4b-activation-readiness.md](phase-4b-activation-readiness.md) | Activation gate, provider wiring, no-query guarantee, freeze/recovery verification |
| [phase-4b-activation-runbook.md](phase-4b-activation-runbook.md) | Exact future sequence to deploy and activate remote rollout |
| [phase-4-rollout-control.md](phase-4-rollout-control.md) | Per-user rollout, kill switch, caching, RLS model, operator workflow |
| [phase-3-dogfood.md](phase-3-dogfood.md) | Engine selection, internal eligibility, fallback, provenance, telemetry privacy, rollback |
| [phase-2c.md](phase-2c.md) | Adapter, recovery, discard, handoff — coverage and evidence |
| [phase-2b.md](phase-2b.md) | Durable foreground audio engine |
| [roadmap.md](roadmap.md) | Phase 3, Phase 4, background recording, future work |

## Status

Native recording is **implemented but gated off**. The committed value of
`CONFIGURED_RECORDING_ENGINE` is `legacy`; production uses the legacy Expo
recorder. Internal builds may opt in via a build-time cohort flag — see
[phase-3-dogfood.md](phase-3-dogfood.md). Per-user rollout control is wired but
**inactive by default**: the activation gate is off, so the app makes zero
rollout requests, and its backend is **not deployed** — see
[phase-4b-activation-readiness.md](phase-4b-activation-readiness.md). One manual physical gate remains
before native can become the default — see
[release-checklist.md](release-checklist.md).

No recording audio is stored in this repository. Physical verification evidence
is recorded as metadata and hashes only.
