#!/usr/bin/env node
// Recording-only verification. This is the command to run while working on
// anything that touches recording: it proves persistence, capture, resume,
// discard, export, handoff, idempotency and relaunch without a physical device.
import { nodeStep, runSteps } from './lib/verification.mjs';

const passed = await runSteps('Native recording verification', [
  nodeStep('persistence (durable session store)', 'scripts/durable-recorder-session.test.mjs'),
  nodeStep('capture engine (AAC segments)', 'scripts/durable-recorder-audio.test.mjs'),
  nodeStep('checkpoint policy + long-session counts', 'scripts/durable-recorder-checkpoint.test.mjs'),
  nodeStep('R6 verify gate isolation', 'scripts/r6-verify-gate.test.mjs'),
  nodeStep('native contract (JS <-> Swift)', 'scripts/durable-recorder-contract.test.mjs'),
  nodeStep('exporter (final asset assembly)', 'scripts/durable-recorder-finalization.test.mjs'),
  nodeStep('recovery / resume / discard / relaunch', 'scripts/durable-recorder-recovery.test.mjs'),
  nodeStep('forced-pause status sync', 'scripts/durable-recorder-status-sync.test.mjs'),
  nodeStep('recorder adapter + feature gate', 'scripts/recording-adapter.test.mjs'),
  nodeStep('engine selection policy + fallback', 'scripts/recording-engine-policy.test.mjs'),
  nodeStep('rollout control + failure matrix', 'scripts/recording-rollout.test.mjs'),
  nodeStep('rollout activation gate + wiring', 'scripts/recording-rollout-activation.test.mjs'),
  nodeStep('rollout admin + migration RLS', 'scripts/rollout-admin.test.mjs'),
  nodeStep('diagnostics privacy boundary', 'scripts/recording-diagnostics.test.mjs'),
  nodeStep('engine provenance + recovery routing', 'scripts/recording-provenance.test.mjs'),
  nodeStep('recording persistence (lecture side)', 'scripts/recording-persistence.test.mjs'),
  nodeStep('legacy session duration (resume contamination fix)', 'scripts/recording-session-duration.test.mjs'),
  nodeStep('live-caption reconnect budget (no infinite retry storm)', 'scripts/live-caption-reconnect-budget.test.mjs'),
  nodeStep('caption popup live-edge (Mini panel reopen resets to live)', 'scripts/mini-caption-live-edge.test.mjs'),
  nodeStep('caption panel resize performance (no per-frame rerender)', 'scripts/mini-caption-resize-performance.test.mjs'),
  nodeStep('Course Material caption visibility (active session survives review route)', 'scripts/material-caption-visibility.test.mjs'),
  nodeStep('Caption window behavior parity (Notes vs Course Material)', 'scripts/caption-window-behavior-parity.test.mjs'),
  nodeStep('Lecture Detail playback scrubber (drag/seek)', 'scripts/playback-scrubber.test.mjs'),
  nodeStep('processing resume', 'scripts/processing-resume.test.mjs'),
  nodeStep('lecture startup state', 'scripts/lecture-startup-state.test.mjs'),
  nodeStep('Pause→Resume caption history continuity', 'scripts/recording-caption-pause-resume.test.mjs'),
  nodeStep('Mini/Course Resume + lecture playback audio mode', 'scripts/lecture-session-resume-playback.test.mjs'),
  nodeStep('Lecture local playback gating', 'scripts/lecture-local-playback.test.mjs'),
  nodeStep('Transcript edit continuity', 'scripts/transcript-edit.test.mjs'),
]);

if (passed) {
  console.log(`
Covered:
  persistence   durable sessions survive process death
  resume        recovery appends a new immutable segment
  discard       durable state removed, no downstream asset
  exporter      segment order preserved in the final asset
  handoff       downstream handoff acknowledged durably
  idempotency   repeated export / ack never duplicate
  relaunch      a restart never re-offers acknowledged audio
`);
}

process.exit(passed ? 0 : 1);
