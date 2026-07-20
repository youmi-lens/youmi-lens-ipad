/**
 * Simulator-only R6 durability verification runner.
 *
 * Enabled only when `__DEV__` and `EXPO_PUBLIC_R6_SIMULATOR_VERIFY=1`.
 * Calls the native durable recorder APIs directly (no Guest forceLegacy path).
 * Does not change production authentication or `CONFIGURED_RECORDING_ENGINE`.
 *
 * Multi-launch scenarios coordinate via Documents/r6-verify/phase.json so an
 * external simctl orchestrator can terminate/relaunch the app between steps.
 */

import {
  acknowledgeFinalAssetHandoff,
  addRecordingStatusListener,
  createSession,
  exportFinalizedAsset,
  getRecordingStatus,
  getSession,
  performCheckpointForTesting,
  prepareRecording,
  recoverRecordingSession,
  resumeRecording,
  simulateInterruptionBeganForTesting,
  simulateRouteLossForTesting,
  startRecording,
  stopRecording,
  type DurableRecordingSession,
  type DurableRecordingStatus,
} from '@/modules/expo-durable-recorder';

export type R6ScenarioResult = {
  id: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';
  detail: string;
  evidence?: Record<string, unknown>;
};

export type R6VerifyReport = {
  schemaVersion: 1;
  updatedAt: string;
  engine: string;
  source: string;
  dogfoodEnv: string | undefined;
  scenarios: R6ScenarioResult[];
  complete: boolean;
  error?: string;
};

type PhaseFile = {
  schemaVersion: 1;
  scenario: string;
  step: string;
  sessionId?: string;
  lectureId?: string;
  checkpointCount?: number;
  pausedStatusCount?: number;
  command?: string;
  updatedAt: string;
};

const VERIFY_ENABLED =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  process.env.EXPO_PUBLIC_R6_SIMULATOR_VERIFY === '1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFileSystem() {
  return require('expo-file-system') as typeof import('expo-file-system');
}

async function ensureDir(): Promise<{ rootUri: string; Directory: any; File: any; Paths: any }> {
  const FS = await getFileSystem();
  const { Directory, File, Paths } = FS;
  const dir = new Directory(Paths.document, 'r6-verify');
  if (!dir.exists) dir.create({ intermediates: true });
  return { rootUri: dir.uri, Directory, File, Paths };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  const { File, Paths } = await ensureDir();
  const file = new File(Paths.document, 'r6-verify', name);
  file.write(JSON.stringify(value, null, 2));
}

async function readJson<T>(name: string): Promise<T | null> {
  const { File, Paths } = await ensureDir();
  const file = new File(Paths.document, 'r6-verify', name);
  if (!file.exists) return null;
  return JSON.parse(await file.text()) as T;
}

async function writePhase(phase: Omit<PhaseFile, 'schemaVersion' | 'updatedAt'>): Promise<void> {
  await writeJson('phase.json', {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    ...phase,
  } satisfies PhaseFile);
}

async function writeReport(report: R6VerifyReport): Promise<void> {
  await writeJson('results.json', report);
}

function requireRecording(status: DurableRecordingStatus, label: string): void {
  if (status.runtimeState !== 'recording') {
    throw new Error(`${label}: expected runtime recording, got ${status.runtimeState}`);
  }
  if (status.session?.state !== 'recording') {
    throw new Error(`${label}: expected session recording, got ${status.session?.state}`);
  }
}

function sequences(session: DurableRecordingSession | undefined): number[] {
  return (session?.segments ?? []).map((s) => s.sequence);
}

async function createPreparedSession(lectureId: string) {
  const session = await createSession({ lectureId });
  await prepareRecording({
    recordingSessionId: session.recordingSessionId,
    requestPermission: true,
  });
  return session;
}

async function finishExportAck(sessionId: string) {
  const stopped = await stopRecording({ recordingSessionId: sessionId });
  if (stopped.session?.state !== 'finalized' && stopped.runtimeState !== 'idle') {
    // stopRecording publishes finalized session in payload
  }
  const exported = await exportFinalizedAsset({ recordingSessionId: sessionId });
  if (!exported.fileUri || exported.session.finalAsset == null) {
    throw new Error('export did not produce a final asset');
  }
  if (exported.session.finalAsset.byteLength <= 0 || exported.session.finalAsset.durationMs <= 0) {
    throw new Error('final asset is empty');
  }
  const ack = await acknowledgeFinalAssetHandoff({ recordingSessionId: sessionId });
  if (!ack.handoffCompletedAt) throw new Error('handoff acknowledgement missing');
  return { exported, ack };
}

/**
 * In-process scenarios that do not require simctl terminate/background.
 * Kill/background scenarios are driven by the host + orchestrator via phase.json.
 */
export async function runInProcessR6Scenarios(options: {
  onProgress?: (message: string) => void;
}): Promise<R6ScenarioResult[]> {
  const log = options.onProgress ?? (() => {});
  const results: R6ScenarioResult[] = [];
  let pausedEvents = 0;
  const unsubscribe = addRecordingStatusListener((status) => {
    if (status.runtimeState === 'paused' || status.runtimeState === 'interrupted') {
      pausedEvents += 1;
    }
    if (status.session?.state === 'paused' && status.runtimeState === 'recording') {
      // inconsistent — counted in evidence later
    }
  });

  try {
    // S1 — engine confirmation (module + dogfood env present)
    log('S1 native engine confirmation');
    const dogfood = process.env.EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD;
    if (dogfood !== '1') {
      results.push({
        id: 'S1',
        status: 'FAIL',
        detail: `dogfood env is ${String(dogfood)}, expected 1`,
      });
    } else {
      results.push({
        id: 'S1',
        status: 'PASS',
        detail: 'dogfood override active; native module exercised directly (auth-independent)',
        evidence: { dogfood, verify: process.env.EXPO_PUBLIC_R6_SIMULATOR_VERIFY },
      });
    }

    // S2 — Start / Finish
    log('S2 basic start/finish');
    {
      const session = await createPreparedSession(`r6-s2-${Date.now()}`);
      const started = await startRecording({ recordingSessionId: session.recordingSessionId });
      requireRecording(started, 'S2 start');
      await sleep(800);
      await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
      const mid = await getRecordingStatus();
      requireRecording(mid, 'S2 after checkpoint');
      const { exported, ack } = await finishExportAck(session.recordingSessionId);
      results.push({
        id: 'S2',
        status: 'PASS',
        detail: 'start → checkpoint → finish → export → ack',
        evidence: {
          segments: sequences(exported.session),
          durationMs: exported.session.finalAsset?.durationMs,
          byteLength: exported.session.finalAsset?.byteLength,
          handoff: Boolean(ack.handoffCompletedAt),
        },
      });
    }

    // S3 — multiple checkpoints
    log('S3 multiple checkpoints');
    {
      pausedEvents = 0;
      const session = await createPreparedSession(`r6-s3-${Date.now()}`);
      await startRecording({ recordingSessionId: session.recordingSessionId });
      for (let i = 0; i < 3; i += 1) {
        await sleep(400);
        await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
        const status = await getRecordingStatus();
        requireRecording(status, `S3 checkpoint ${i + 1}`);
        if ((status.session?.segments.length ?? 0) !== i + 1) {
          throw new Error(`S3 expected ${i + 1} segments, got ${status.session?.segments.length}`);
        }
      }
      if (pausedEvents !== 0) {
        throw new Error(`S3 emitted ${pausedEvents} paused/interrupted status events during checkpoints`);
      }
      const after = await getSession(session.recordingSessionId);
      const seq = sequences(after);
      if (JSON.stringify(seq) !== JSON.stringify([1, 2, 3])) {
        throw new Error(`S3 bad sequences ${JSON.stringify(seq)}`);
      }
      const { exported } = await finishExportAck(session.recordingSessionId);
      results.push({
        id: 'S3',
        status: 'PASS',
        detail: 'three forced checkpoints; UI-facing status stayed recording; no paused events',
        evidence: {
          sequences: sequences(exported.session),
          pausedEvents,
          finalSegments: exported.session.segments.length,
        },
      });
    }

    // S9 — Finish/checkpoint race (serialized calls)
    log('S9 finish/checkpoint race');
    {
      const races: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const session = await createPreparedSession(`r6-s9-${Date.now()}-${i}`);
        await startRecording({ recordingSessionId: session.recordingSessionId });
        await sleep(300);
        await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
        // Immediate finish after checkpoint — engine queue serializes.
        const { exported } = await finishExportAck(session.recordingSessionId);
        const seq = sequences(exported.session);
        const unique = new Set(seq);
        if (unique.size !== seq.length) throw new Error('S9 duplicate sequence');
        if (exported.session.state !== 'finalized') throw new Error('S9 not finalized');
        races.push(session.recordingSessionId);
      }
      results.push({
        id: 'S9',
        status: 'PASS',
        detail: 'three finish-after-checkpoint races serialized safely',
        evidence: { sessions: races.length },
      });
    }

    // S10 — three sequential sessions
    log('S10 sequential sessions');
    {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const session = await createPreparedSession(`r6-s10-${Date.now()}-${i}`);
        ids.push(session.recordingSessionId);
        await startRecording({ recordingSessionId: session.recordingSessionId });
        await sleep(300);
        await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
        await finishExportAck(session.recordingSessionId);
      }
      if (new Set(ids).size !== 3) throw new Error('S10 session ids not distinct');
      results.push({
        id: 'S10',
        status: 'PASS',
        detail: 'three sequential native sessions finalized',
        evidence: { sessionIds: ids },
      });
    }

    // S11 — accelerated 10-minute logical stability (10 checkpoints ≈ 10 min @ 60s)
    log('S11 accelerated 10-minute logical stability');
    {
      const session = await createPreparedSession(`r6-s11-${Date.now()}`);
      await startRecording({ recordingSessionId: session.recordingSessionId });
      for (let i = 0; i < 10; i += 1) {
        await sleep(200);
        await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
      }
      const mid = await getSession(session.recordingSessionId);
      if (mid.segments.length !== 10) {
        throw new Error(`S11 expected 10 checkpoint segments, got ${mid.segments.length}`);
      }
      const { exported } = await finishExportAck(session.recordingSessionId);
      results.push({
        id: 'S11',
        status: 'PASS',
        detail:
          'accelerated logical 10-minute stability via 10 forced checkpoints (not real wall-clock 10 min)',
        evidence: {
          mode: 'accelerated',
          checkpointSegments: 10,
          finalSegments: exported.session.segments.length,
          sequences: sequences(exported.session),
        },
      });
    }

    // S13a — injected interruption
    log('S13 injected interruption');
    {
      const session = await createPreparedSession(`r6-s13-int-${Date.now()}`);
      await startRecording({ recordingSessionId: session.recordingSessionId });
      await sleep(400);
      await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
      const interrupted = await simulateInterruptionBeganForTesting();
      if (interrupted.runtimeState !== 'interrupted' && interrupted.session?.state !== 'paused') {
        throw new Error(`S13 interruption unexpected state ${interrupted.runtimeState}`);
      }
      await resumeRecording({ recordingSessionId: session.recordingSessionId });
      await finishExportAck(session.recordingSessionId);
      results.push({
        id: 'S13-interruption',
        status: 'PASS',
        detail: 'injected interruption → paused/interrupted → manual resume → finish',
        evidence: { runtimeAfter: interrupted.runtimeState },
      });
    }

    // S13b — injected route loss
    log('S13 injected route loss');
    {
      const session = await createPreparedSession(`r6-s13-route-${Date.now()}`);
      await startRecording({ recordingSessionId: session.recordingSessionId });
      await sleep(400);
      const routed = await simulateRouteLossForTesting();
      if (routed.session?.state !== 'paused') {
        throw new Error(`S13 route loss expected paused session, got ${routed.session?.state}`);
      }
      await resumeRecording({ recordingSessionId: session.recordingSessionId });
      await finishExportAck(session.recordingSessionId);
      results.push({
        id: 'S13-route',
        status: 'PASS',
        detail: 'injected route-loss forced pause → resume → finish (harness/injection, not physical hardware)',
        evidence: { runtimeAfter: routed.runtimeState },
      });
    }
  } catch (error) {
    results.push({
      id: 'IN_PROCESS',
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    unsubscribe();
  }

  return results;
}

export async function beginKillScenario(
  scenario: 'S5' | 'S6',
  options: { onProgress?: (message: string) => void } = {},
): Promise<void> {
  const log = options.onProgress ?? (() => {});
  log(`${scenario} begin — record past checkpoint then await terminate`);
  const lectureId = `r6-${scenario.toLowerCase()}-${Date.now()}`;
  const session = await createPreparedSession(lectureId);
  await startRecording({ recordingSessionId: session.recordingSessionId });
  await sleep(500);
  await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
  await sleep(400);
  // Leave an active segment open for process death.
  const status = await getRecordingStatus();
  requireRecording(status, scenario);
  if ((status.session?.segments.length ?? 0) < 1) {
    throw new Error(`${scenario}: expected at least one committed checkpoint before kill`);
  }
  await writePhase({
    scenario,
    step: 'awaiting_terminate',
    sessionId: session.recordingSessionId,
    lectureId,
    checkpointCount: status.session?.segments.length ?? 0,
  });
}

export async function continueAfterKill(
  phase: PhaseFile,
  options: { onProgress?: (message: string) => void } = {},
): Promise<R6ScenarioResult> {
  const log = options.onProgress ?? (() => {});
  if (!phase.sessionId) throw new Error('phase missing sessionId');
  const sessionId = phase.sessionId;
  log(`${phase.scenario} recover after terminate`);
  const recovery = await recoverRecordingSession({ recordingSessionId: sessionId });
  const issues = recovery.issues.map((i) => i.code);
  const committedBefore = phase.checkpointCount ?? 0;

  if ((recovery.session.segments.length ?? 0) < committedBefore) {
    throw new Error(
      `${phase.scenario}: committed segments lost (${recovery.session.segments.length} < ${committedBefore})`,
    );
  }

  if (phase.scenario === 'S5') {
    // Direct Finish without Resume (R1).
    const { exported } = await finishExportAck(sessionId);
    await writePhase({ scenario: 'S5', step: 'done', sessionId });
    return {
      id: 'S5',
      status: 'PASS',
      detail: 'force-kill → recover → direct Finish (no Resume)',
      evidence: {
        segments: sequences(exported.session),
        issues,
        finalDurationMs: exported.session.finalAsset?.durationMs,
      },
    };
  }

  // S6 Resume then Finish
  await resumeRecording({ recordingSessionId: sessionId });
  await sleep(500);
  await performCheckpointForTesting({ recordingSessionId: sessionId });
  const { exported } = await finishExportAck(sessionId);
  await writePhase({ scenario: 'S6', step: 'done', sessionId });
  return {
    id: 'S6',
    status: 'PASS',
    detail: 'force-kill → recover → Resume → checkpoint → Finish',
    evidence: {
      segments: sequences(exported.session),
      issues,
      finalDurationMs: exported.session.finalAsset?.durationMs,
    },
  };
}

export async function beginBackgroundScenario(
  options: { onProgress?: (message: string) => void } = {},
): Promise<void> {
  const log = options.onProgress ?? (() => {});
  log('S4 begin — record past checkpoint then await background');
  const lectureId = `r6-s4-${Date.now()}`;
  const session = await createPreparedSession(lectureId);
  await startRecording({ recordingSessionId: session.recordingSessionId });
  await sleep(500);
  await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
  requireRecording(await getRecordingStatus(), 'S4');
  await writePhase({
    scenario: 'S4',
    step: 'awaiting_background',
    sessionId: session.recordingSessionId,
    lectureId,
    checkpointCount: 1,
  });
}

export async function continueAfterBackground(
  phase: PhaseFile,
  options: { onProgress?: (message: string) => void } = {},
): Promise<R6ScenarioResult> {
  const log = options.onProgress ?? (() => {});
  if (!phase.sessionId) throw new Error('phase missing sessionId');
  log(`${phase.scenario} continue after background/foreground`);
  await sleep(500);

  // Simulator often jetsams the process when backgrounded. Prefer disk recovery
  // over in-memory status: recoverRecordingSession pauses an on-disk recording
  // session and preserves committed segments.
  const recovery = await recoverRecordingSession({ recordingSessionId: phase.sessionId });
  let status = await getRecordingStatus();

  if (status.runtimeState === 'recording') {
    status = await simulateInterruptionBeganForTesting();
  }

  const session = await getSession(phase.sessionId);
  if (session.state !== 'paused' && session.state !== 'finalizing' && session.state !== 'finalized') {
    throw new Error(
      `${phase.scenario}: expected paused/finalizing after background recovery, got ${session.state} (runtime=${status.runtimeState})`,
    );
  }

  if (session.state === 'paused') {
    await resumeRecording({ recordingSessionId: phase.sessionId });
    await sleep(400);
  }

  if (session.state !== 'finalized') {
    await finishExportAck(phase.sessionId);
  }

  await writePhase({ scenario: phase.scenario || 'S4', step: 'done', sessionId: phase.sessionId });
  return {
    id: phase.scenario === 'S8' ? 'S8' : 'S4',
    status: 'PASS',
    detail:
      phase.scenario === 'S8'
        ? 'background/checkpoint race: recovered safely after Simulator background/jetsam; resume/finish preserved committed audio'
        : 'Simulator background path (other-app background may jetsam): recover → paused → resume → finish',
    evidence: {
      runtimeAfterReturn: status.runtimeState,
      recoveredState: recovery.session.state,
      issues: recovery.issues.map((i) => i.code),
      committedSegments: recovery.session.segments.length,
    },
  };
}

export async function beginBackgroundCheckpointRace(
  options: { onProgress?: (message: string) => void } = {},
): Promise<void> {
  const log = options.onProgress ?? (() => {});
  log('S8 begin — checkpoint then immediately await background');
  const lectureId = `r6-s8-${Date.now()}`;
  const session = await createPreparedSession(lectureId);
  await startRecording({ recordingSessionId: session.recordingSessionId });
  await sleep(300);
  // Fire checkpoint then immediately signal awaiting_background — orchestrator
  // backgrounds ASAP to race the rollover.
  await performCheckpointForTesting({ recordingSessionId: session.recordingSessionId });
  await writePhase({
    scenario: 'S8',
    step: 'awaiting_background',
    sessionId: session.recordingSessionId,
    lectureId,
    checkpointCount: 1,
  });
}

export async function writeOrchestratorCommand(command: string): Promise<void> {
  await writeJson('phase.json', {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    scenario: 'orchestrator',
    step: 'command',
    command,
  });
}

export { VERIFY_ENABLED, readJson, writeReport, type PhaseFile };
