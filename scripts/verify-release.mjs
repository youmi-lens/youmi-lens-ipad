#!/usr/bin/env node
// Full release verification for the recording stack.
//
//   node scripts/verify-release.mjs            full run, including simulator build
//   node scripts/verify-release.mjs --fast     skip the simulator build
//
// Exits non-zero if anything fails, so it is safe to use as a release gate.
import { readdir } from 'node:fs/promises';

import {
  checkFeatureGate,
  checkRolloutDefaults,
  checkWorkingTree,
  nodeStep,
  runCommand,
  runSteps,
  simulatorBuild,
} from './lib/verification.mjs';
import { sourceUrl } from './lib/swift-harness.mjs';

const fast = process.argv.includes('--fast');

const scriptsDirectory = sourceUrl('scripts/');
const allTests = (await readdir(scriptsDirectory))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

const steps = [
  { name: 'feature gate is legacy', run: checkFeatureGate },
  { name: 'rollout ships inert', run: checkRolloutDefaults },
  { name: 'typescript', run: () => runCommand('npx', ['tsc', '--noEmit']) },
  { name: 'lint', run: () => runCommand('npx', ['expo', 'lint']) },
  ...allTests.map((name) => nodeStep(name.replace(/\.test\.mjs$/, ''), `scripts/${name}`)),
];

if (!fast) {
  steps.push({ name: 'ios simulator build', run: simulatorBuild });
}

// Checked last: an otherwise-green run should still tell you the tree is dirty.
steps.push({ name: 'working tree is committed', run: checkWorkingTree });

const passed = await runSteps(
  `Release verification${fast ? ' (fast: no simulator build)' : ''}`,
  steps,
);

console.log(
  passed
    ? '\nRelease readiness: READY — automated gates green.\n' +
        'One manual gate remains before enabling native recording as the default:\n' +
        'see docs/verification/release-checklist.md (RELEASE ONLY, ~2 minutes).\n'
    : '\nRelease readiness: BLOCKED — resolve the failures above.\n',
);

process.exit(passed ? 0 : 1);
