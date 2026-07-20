#!/usr/bin/env node
/**
 * R6 Simulator durability orchestrator.
 *
 * Drives the in-app R6SimulatorVerifyHost via Documents/r6-verify/{phase,results}.json
 * and simctl lifecycle (background / terminate / relaunch).
 *
 * Does not touch the physical iPad. Uses an isolated Simulator device.
 *
 * Prerequisites (local, gitignored):
 *   EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD=1
 *   EXPO_PUBLIC_R6_SIMULATOR_VERIFY=1
 */

import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const BUNDLE_ID = 'com.aydenz.youmilensipad';
const DEVICE_NAME = 'iPad Air 11-inch (M4)';
const REPO = new URL('../', import.meta.url).pathname;
const OUT_DIR = join(REPO, 'docs/verification/r6-simulator-artifacts');

function sh(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: REPO,
    ...opts,
  });
  if (result.status !== 0 && opts.allowFail !== true) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function simctl(...args) {
  return sh('xcrun', ['simctl', ...args]);
}

function deviceUdid() {
  const listed = sh('xcrun', ['simctl', 'list', 'devices', 'available']).stdout;
  const line = listed
    .split('\n')
    .find((l) => l.includes(DEVICE_NAME) && l.includes('(') && !l.includes('unavailable'));
  assert.ok(line, `Simulator ${DEVICE_NAME} not found`);
  const match = line.match(/\(([0-9A-F-]{36})\)/i);
  assert.ok(match, `UDID missing for ${DEVICE_NAME}`);
  return match[1];
}

function boot(udid) {
  const booted = sh('xcrun', ['simctl', 'list', 'devices', 'booted']).stdout;
  if (!booted.includes(udid)) {
    simctl('boot', udid);
  }
  sh('open', ['-a', 'Simulator']);
}

function appDataRoot(udid) {
  const result = sh('xcrun', ['simctl', 'get_app_container', udid, BUNDLE_ID, 'data'], {
    allowFail: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function verifyPaths(udid) {
  const data = appDataRoot(udid);
  if (!data) return null;
  return {
    data,
    results: join(data, 'Documents', 'r6-verify', 'results.json'),
    phase: join(data, 'Documents', 'r6-verify', 'phase.json'),
  };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function waitFor(predicate, { timeoutMs = 180_000, intervalMs = 1500, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function launch(udid) {
  // Clear prior launch; open app against Metro if available.
  sh('xcrun', ['simctl', 'terminate', udid, BUNDLE_ID], { allowFail: true });
  simctl(
    'launch',
    udid,
    BUNDLE_ID,
  );
}

function backgroundViaSafari(udid) {
  // Launching another app backgrounds YoumiLens and triggers didEnterBackground.
  sh('xcrun', ['simctl', 'launch', udid, 'com.apple.mobilesafari'], { allowFail: true });
}

function terminate(udid) {
  sh('xcrun', ['simctl', 'terminate', udid, BUNDLE_ID]);
}

function grantMic(udid) {
  sh('xcrun', ['simctl', 'privacy', udid, 'grant', 'microphone', BUNDLE_ID], { allowFail: true });
}

function writePhaseCommand(udid, command) {
  const paths = verifyPaths(udid);
  assert.ok(paths, 'app data container missing — is the app installed?');
  const dir = join(paths.data, 'Documents', 'r6-verify');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    paths.phase,
    JSON.stringify(
      {
        schemaVersion: 1,
        scenario: 'orchestrator',
        step: 'command',
        command,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function clearVerifyState(udid) {
  const paths = verifyPaths(udid);
  if (!paths) return;
  rmSync(join(paths.data, 'Documents', 'r6-verify'), { recursive: true, force: true });
}

function sampleMemory(udid) {
  const ps = sh('ps', ['aux']).stdout;
  const lines = ps.split('\n').filter((l) => /YoumiLens|Simulator|node .*expo|metro/i.test(l));
  const youmi = lines.find((l) => l.includes('YoumiLens.app'));
  let rssKb = null;
  if (youmi) {
    const parts = youmi.trim().split(/\s+/);
    // ps aux: USER PID %CPU %MEM VSZ RSS ...
    rssKb = Number(parts[5]) || null;
  }
  return {
    rssKb,
    matchingProcessCount: lines.length,
    nodeExpoLines: lines.filter((l) => /node/.test(l)).length,
  };
}

async function waitPhase(udid, step, scenario) {
  return waitFor(
    () => {
      const paths = verifyPaths(udid);
      if (!paths) return null;
      const phase = readJson(paths.phase);
      if (!phase) return null;
      if (step && phase.step !== step) return null;
      if (scenario && phase.scenario !== scenario) return null;
      return phase;
    },
    { label: `phase ${scenario ?? ''} ${step}`, timeoutMs: 300_000 },
  );
}

async function runLifecycle(udid) {
  const memorySamples = [];

  // --- In-process ---
  clearVerifyState(udid);
  writePhaseCommand(udid, 'run_in_process');
  memorySamples.push({ at: 'pre_launch', ...sampleMemory(udid) });
  launch(udid);
  await waitFor(
    () => {
      const paths = verifyPaths(udid);
      const results = paths && readJson(paths.results);
      const phase = paths && readJson(paths.phase);
      if (results?.scenarios?.some((s) => s.id === 'S3' && s.status === 'PASS') &&
          phase?.command === 'start_s4') {
        return results;
      }
      // Also accept phase awaiting from start_s4 already begun
      if (phase?.step === 'awaiting_background' && phase?.scenario === 'S4') return results ?? true;
      if (phase?.command === 'start_s4') return results ?? true;
      return null;
    },
    { label: 'in-process completion', timeoutMs: 420_000 },
  );
  memorySamples.push({ at: 'after_in_process', ...sampleMemory(udid) });

  // --- S4 background ---
  writePhaseCommand(udid, 'start_s4');
  launch(udid);
  await waitPhase(udid, 'awaiting_background', 'S4');
  backgroundViaSafari(udid);
  await delay(2500);
  // Mark awaiting_foreground then relaunch app
  {
    const paths = verifyPaths(udid);
    const phase = readJson(paths.phase);
    writeFileSync(
      paths.phase,
      JSON.stringify({ ...phase, step: 'awaiting_foreground', updatedAt: new Date().toISOString() }, null, 2),
    );
  }
  launch(udid);
  await waitFor(
    () => {
      const paths = verifyPaths(udid);
      const results = readJson(paths?.results);
      return results?.scenarios?.find((s) => s.id === 'S4' && s.status === 'PASS') ?? null;
    },
    { label: 'S4 PASS', timeoutMs: 180_000 },
  );

  // --- S8 race ---
  writePhaseCommand(udid, 'start_s8');
  launch(udid);
  await waitPhase(udid, 'awaiting_background', 'S8');
  backgroundViaSafari(udid);
  await delay(1500);
  {
    const paths = verifyPaths(udid);
    const phase = readJson(paths.phase);
    writeFileSync(
      paths.phase,
      JSON.stringify({ ...phase, step: 'awaiting_foreground', updatedAt: new Date().toISOString() }, null, 2),
    );
  }
  launch(udid);
  await waitFor(
    () => {
      const paths = verifyPaths(udid);
      const results = readJson(paths?.results);
      return results?.scenarios?.find((s) => s.id === 'S8' && s.status === 'PASS') ?? null;
    },
    { label: 'S8 PASS', timeoutMs: 180_000 },
  );

  // --- S5 kill + direct Finish ---
  writePhaseCommand(udid, 'start_s5');
  launch(udid);
  await waitPhase(udid, 'awaiting_terminate', 'S5');
  terminate(udid);
  await delay(1000);
  launch(udid);
  await waitFor(
    () => {
      const paths = verifyPaths(udid);
      const results = readJson(paths?.results);
      return results?.scenarios?.find((s) => s.id === 'S5' && s.status === 'PASS') ?? null;
    },
    { label: 'S5 PASS', timeoutMs: 240_000 },
  );
  memorySamples.push({ at: 'after_s5', ...sampleMemory(udid) });

  // --- S6 kill + Resume ---
  writePhaseCommand(udid, 'start_s6');
  launch(udid);
  await waitPhase(udid, 'awaiting_terminate', 'S6');
  terminate(udid);
  await delay(1000);
  launch(udid);
  await waitFor(
    () => {
      const paths = verifyPaths(udid);
      const results = readJson(paths?.results);
      return results?.scenarios?.find((s) => s.id === 'S6' && s.status === 'PASS') ?? null;
    },
    { label: 'S6 PASS', timeoutMs: 240_000 },
  );
  memorySamples.push({ at: 'after_s6', ...sampleMemory(udid) });

  // Finalize
  writePhaseCommand(udid, 'finalize');
  launch(udid);
  await waitFor(
    () => {
      const paths = verifyPaths(udid);
      const results = readJson(paths?.results);
      return results?.complete === true ? results : null;
    },
    { label: 'finalize complete', timeoutMs: 120_000 },
  );

  return { memorySamples, results: readJson(verifyPaths(udid).results) };
}

async function runHarnessS7() {
  // Existing recovery Swift harness covers promotion-before-metadata (R4).
  const result = sh('node', ['scripts/durable-recorder-recovery.test.mjs']);
  return {
    id: 'S7',
    status: result.status === 0 ? 'PASS' : 'FAIL',
    detail: 'recovery Swift harness — orphan finalized segment adoption (R4)',
    layer: 'native-harness',
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // Ensure local env flags (gitignored).
  const envLocal = join(REPO, '.env.local');
  let envText = existsSync(envLocal) ? readFileSync(envLocal, 'utf8') : '';
  if (!/EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD=1/.test(envText)) {
    envText += '\nEXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD=1\n';
  }
  if (!/EXPO_PUBLIC_R6_SIMULATOR_VERIFY=1/.test(envText)) {
    envText += '\nEXPO_PUBLIC_R6_SIMULATOR_VERIFY=1\n';
  }
  writeFileSync(envLocal, envText);

  const udid = deviceUdid();
  console.log(`Using Simulator ${DEVICE_NAME} (${udid})`);
  boot(udid);
  grantMic(udid);

  // Metro
  const metro = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:8081/status'], {
    encoding: 'utf8',
  });
  if (metro.stdout !== '200' && metro.stdout !== 'packager-status:running') {
    // status endpoint returns body packager-status:running with 200 sometimes as plain
  }
  const statusBody = spawnSync('curl', ['-s', 'http://localhost:8081/status'], { encoding: 'utf8' });
  if (!statusBody.stdout?.includes('running')) {
    console.log('Starting Metro…');
    spawnSync('npx', ['expo', 'start', '--dev-client', '--port', '8081'], {
      cwd: REPO,
      detached: true,
      stdio: 'ignore',
    });
    await delay(8000);
  }

  // Install/build on isolated simulator
  console.log('Building/installing for isolated Simulator…');
  const build = sh(
    'npx',
    ['expo', 'run:ios', '--device', DEVICE_NAME, '--no-bundler'],
    { allowFail: true },
  );
  if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    throw new Error('expo run:ios failed for isolated Simulator');
  }

  const s7 = await runHarnessS7();
  const { memorySamples, results } = await runLifecycle(udid);

  // Merge S7 into results artifact
  const merged = {
    ...results,
    scenarios: [...(results?.scenarios ?? []).filter((s) => s.id !== 'S7'), s7],
    memorySamples,
    simulator: { name: DEVICE_NAME, udid, os: 'iOS 26.5' },
    automation: 'in-app R6SimulatorVerifyHost + simctl orchestrator',
    authApproach: 'native module APIs directly (no Guest forceLegacy; no production auth change)',
    checkpointMode: 'forced performCheckpointForTesting (DEBUG) for accelerated scenarios',
    physicalCheckpointRetained: 'PASS (prior manual physical iPad test)',
  };

  writeFileSync(join(OUT_DIR, 'latest-results.json'), JSON.stringify(merged, null, 2));
  console.log(JSON.stringify(merged, null, 2));

  const required = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S13-interruption', 'S13-route'];
  const failed = required.filter((id) => {
    const row = merged.scenarios.find((s) => s.id === id);
    return !row || row.status !== 'PASS';
  });
  if (failed.length) {
    console.error('Failed/missing scenarios:', failed.join(', '));
    process.exit(1);
  }
  console.log('R6 Simulator orchestrator: all required scenarios PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
