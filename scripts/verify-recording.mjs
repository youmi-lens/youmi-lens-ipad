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
  nodeStep('processing resume', 'scripts/processing-resume.test.mjs'),
  nodeStep('lecture startup state', 'scripts/lecture-startup-state.test.mjs'),
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
