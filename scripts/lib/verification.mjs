import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { repositoryRoot, sourceUrl } from './swift-harness.mjs';

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

export const projectDirectory = repositoryRoot.pathname;

/** Runs a command, capturing output so only failures are printed in full. */
export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd ?? projectDirectory,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { ok: result.status === 0, output, status: result.status };
}

/** A verification step backed by a node test script. */
export function nodeStep(name, scriptPath) {
  return { name, run: () => runCommand('node', [sourceUrl(scriptPath).pathname]) };
}

/**
 * Executes steps in order, printing a compact PASS/FAIL line each. Failing
 * output is buffered and printed at the end so the summary stays readable.
 */
export async function runSteps(title, steps) {
  console.log(`\n${BOLD}${title}${RESET}\n`);
  const failures = [];

  for (const step of steps) {
    const startedAt = Date.now();
    process.stdout.write(`  ${step.name.padEnd(42, '.')} `);
    let result;
    try {
      result = await step.run();
    } catch (error) {
      result = { ok: false, output: error instanceof Error ? error.stack ?? error.message : String(error) };
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (result.ok) {
      console.log(`${GREEN}PASS${RESET} ${DIM}${seconds}s${RESET}`);
    } else {
      console.log(`${RED}FAIL${RESET} ${DIM}${seconds}s${RESET}`);
      failures.push({ name: step.name, output: result.output ?? '' });
    }
  }

  if (failures.length > 0) {
    console.log(`\n${RED}${BOLD}${failures.length} check(s) failed${RESET}\n`);
    for (const failure of failures) {
      console.log(`${RED}--- ${failure.name} ---${RESET}`);
      console.log(failure.output.trim().split('\n').slice(-40).join('\n'));
      console.log('');
    }
    return false;
  }

  console.log(`\n${GREEN}${BOLD}All ${steps.length} checks passed.${RESET}`);
  return true;
}

/**
 * The production feature gate must ship on legacy. Device verification may flip
 * it locally, so this guards against committing or releasing that state.
 */
export async function checkFeatureGate() {
  const source = await readFile(sourceUrl('lib/recording/featureGate.ts'), 'utf8');
  const match = source.match(/CONFIGURED_RECORDING_ENGINE:\s*RecordingEngine\s*=\s*'([a-zA-Z]+)'/);
  const engine = match?.[1];
  if (engine === 'legacy') return { ok: true, output: '' };
  return {
    ok: false,
    output:
      `Feature gate is '${engine ?? 'unreadable'}', expected 'legacy'.\n` +
      "Restore lib/recording/featureGate.ts to 'legacy' before release.",
  };
}

/**
 * Rollout must ship inert: remote provider off, no build-time cohort, no
 * enrolled user, no service-role credential, and the migration undeployed.
 */
export async function checkRolloutDefaults() {
  const problems = [];
  const gate = await readFile(sourceUrl('lib/recording/featureGate.ts'), 'utf8');
  const envExample = await readFile(sourceUrl('.env.example'), 'utf8');

  if (!/REMOTE_ROLLOUT_ENABLED =\s*process\.env\.EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE === '1'/.test(gate)) {
    problems.push("The remote rollout activation gate is not a strict === '1' check.");
  }
  if (/EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE\s*=\s*1/.test(envExample)) {
    problems.push('.env.example enables remote rollout; it must ship disabled.');
  }
  if (/EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD\s*=\s*1/.test(envExample)) {
    problems.push('.env.example enables the dogfood cohort; it must ship disabled.');
  }

  // No enrolled user, credential, or personal identifier may be committed.
  const client = runCommand('git', ['grep', '-lE', 'SERVICE_ROLE|service_role', '--', 'lib', 'app']);
  if (client.output.trim().length > 0) {
    problems.push(`Service-role reference in client code:\n${client.output.trim()}`);
  }
  const identifiers = runCommand('git', [
    'grep', '-lEI', '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', '--',
    'lib/recording', 'supabase', 'scripts/rollout-admin.mjs',
  ]);
  if (identifiers.output.trim().length > 0) {
    problems.push(`Possible personal identifier committed:\n${identifiers.output.trim()}`);
  }

  return problems.length === 0
    ? { ok: true, output: '' }
    : { ok: false, output: problems.join('\n') };
}

/** A release build must come from a committed, unmodified tree. */
export function checkWorkingTree() {
  const status = runCommand('git', ['status', '--porcelain=v1']);
  if (!status.ok) return { ok: false, output: status.output };
  const dirty = status.output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    // Untracked files are allowed; uncommitted edits to tracked files are not.
    .filter((line) => !line.startsWith('??'));
  if (dirty.length === 0) return { ok: true, output: '' };
  return {
    ok: false,
    output: `Uncommitted changes to tracked files:\n${dirty.join('\n')}`,
  };
}

/** Compiles the app for the iOS Simulator, covering Expo module Swift glue. */
export function simulatorBuild() {
  const destination = 'platform=iOS Simulator,name=iPad Pro 11-inch (M5)';
  return runCommand(
    'xcodebuild',
    [
      '-workspace', 'YoumiLens.xcworkspace',
      '-scheme', 'YoumiLens',
      '-configuration', 'Debug',
      '-sdk', 'iphonesimulator',
      '-destination', destination,
      '-quiet',
      'build',
    ],
    { cwd: `${projectDirectory}ios` },
  );
}
