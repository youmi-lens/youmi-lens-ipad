import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { resolveRecordingEngineDecisionForRuntime } from '@/lib/recording/featureGate';
import {
  VERIFY_ENABLED,
  beginBackgroundCheckpointRace,
  beginBackgroundScenario,
  beginKillScenario,
  continueAfterBackground,
  continueAfterKill,
  readJson,
  runInProcessR6Scenarios,
  writeReport,
  writeOrchestratorCommand,
  type PhaseFile,
  type R6ScenarioResult,
  type R6VerifyReport,
} from '@/lib/recording/r6SimulatorVerify';

/**
 * Simulator R6 host. Mounted only when `__DEV__` and
 * `EXPO_PUBLIC_R6_SIMULATOR_VERIFY=1` (see `isR6SimulatorVerifyEnabled`).
 * Exercises the native durable recorder APIs directly (no Guest forceLegacy).
 * Must never mount from production navigation or release bundles.
 */
export function R6SimulatorVerifyHost() {
  const [message, setMessage] = useState('R6 verify starting…');
  const started = useRef(false);

  useEffect(() => {
    if (!VERIFY_ENABLED || started.current) return;
    started.current = true;
    void runHost();
  }, []);

  if (!VERIFY_ENABLED) return null;

  async function runHost() {
    const progress = (m: string) => setMessage(m);
    const decision = resolveRecordingEngineDecisionForRuntime({ forceLegacy: false });
    const prior = (await readJson<R6VerifyReport>('results.json'))?.scenarios ?? [];
    const phase = await readJson<PhaseFile & { command?: string }>('phase.json');

    try {
      // Resume multi-launch scenarios first.
      if (phase?.step === 'awaiting_terminate' && (phase.scenario === 'S5' || phase.scenario === 'S6')) {
        progress(`Resume ${phase.scenario} after kill…`);
        const result = await continueAfterKill(phase, { onProgress: progress });
        await persist(decision, merge(prior, [result]), false);
        progress(`${phase.scenario} done`);
        return;
      }

      if (
        phase?.step === 'awaiting_foreground' &&
        (phase.scenario === 'S4' || phase.scenario === 'S8')
      ) {
        progress(`Resume ${phase.scenario} after background…`);
        const result = await continueAfterBackground(phase, { onProgress: progress });
        await persist(decision, merge(prior, [result]), false);
        progress(`${phase.scenario} done`);
        return;
      }

      if (phase?.step === 'awaiting_background' || phase?.step === 'awaiting_terminate') {
        progress(`Waiting on orchestrator (${phase.scenario}/${phase.step})`);
        return;
      }

      const command = phase?.command ?? 'run_in_process';

      if (command === 'run_in_process') {
        progress('Running in-process scenarios…');
        const results = await runInProcessR6Scenarios({ onProgress: progress });
        await persist(decision, merge(prior, results), false);
        // Signal orchestrator to start lifecycle scenarios.
        await writeCommandPhase('start_s4');
        progress('In-process done — armed start_s4');
        return;
      }

      if (command === 'start_s4') {
        progress('Arming S4 background scenario…');
        await beginBackgroundScenario({ onProgress: progress });
        await persist(decision, prior, false);
        progress('S4 awaiting_background');
        return;
      }

      if (command === 'start_s8') {
        progress('Arming S8 background/checkpoint race…');
        await beginBackgroundCheckpointRace({ onProgress: progress });
        await persist(decision, prior, false);
        progress('S8 awaiting_background');
        return;
      }

      if (command === 'start_s5') {
        progress('Arming S5 force-kill direct Finish…');
        await beginKillScenario('S5', { onProgress: progress });
        await persist(decision, prior, false);
        progress('S5 awaiting_terminate');
        return;
      }

      if (command === 'start_s6') {
        progress('Arming S6 force-kill Resume…');
        await beginKillScenario('S6', { onProgress: progress });
        await persist(decision, prior, false);
        progress('S6 awaiting_terminate');
        return;
      }

      if (command === 'finalize') {
        await persist(decision, prior, true);
        progress('R6 Simulator verification complete');
        return;
      }

      progress(`Unknown command ${command}`);
    } catch (error) {
      const fail: R6ScenarioResult = {
        id: 'HOST',
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
      };
      await persist(decision, merge(prior, [fail]), false);
      progress(`FAIL: ${fail.detail}`);
    }
  }

  return (
    <View pointerEvents="none" style={styles.banner}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

function merge(prior: R6ScenarioResult[], next: R6ScenarioResult[]): R6ScenarioResult[] {
  const map = new Map<string, R6ScenarioResult>();
  for (const s of prior) {
    if (s.id !== '_note') map.set(s.id, s);
  }
  for (const s of next) map.set(s.id, s);
  return [...map.values()];
}

async function persist(
  decision: { engine: string; source: string },
  scenarios: R6ScenarioResult[],
  complete: boolean,
) {
  const report: R6VerifyReport = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    engine: decision.engine,
    source: decision.source,
    dogfoodEnv: process.env.EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD,
    scenarios,
    complete,
  };
  await writeReport(report);
}

async function writeCommandPhase(command: string) {
  await writeOrchestratorCommand(command);
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 24,
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    zIndex: 9999,
  },
  text: {
    color: '#F8FAFC',
    fontSize: 12,
    fontFamily: 'Menlo',
  },
});
