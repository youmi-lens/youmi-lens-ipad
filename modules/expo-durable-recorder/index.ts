import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export const DURABLE_RECORDER_CONTRACT_VERSION = 1 as const;

export const DURABLE_RECORDING_STATES = [
  'created',
  'preparing',
  'ready',
  'recording',
  'paused',
  'finalizing',
  'finalized',
  'failed',
  'abandoned',
] as const;

export type DurableRecordingState = (typeof DURABLE_RECORDING_STATES)[number];

export type DurableRecorderCapabilities = {
  moduleAvailable: boolean;
  contractVersion: typeof DURABLE_RECORDER_CONTRACT_VERSION;
  platform: string;
  implementation: string;
};

export type DurableRecordingSegment = {
  schemaVersion: 1;
  segmentId: string;
  sequence: number;
  relativePath: string;
  createdAt: string;
  finalizedAt: string;
  durationMs: number;
  byteLength: number;
  container: 'm4a';
  codec: 'aac';
  sampleRate: number;
  channelCount: number;
  integrityStatus: 'validated';
  interruptionReason?: string;
  routeAtStart?: string;
  routeAtEnd?: string;
  recoveredAfterRestart?: boolean;
};

export type DurableRecordingSession = {
  schemaVersion: 1;
  recordingSessionId: string;
  lectureId: string;
  state: DurableRecordingState;
  createdAt: string;
  updatedAt: string;
  relativeSessionPath: string;
  recoverable: boolean;
  finalized: boolean;
  failureCode?: string;
  failureMessage?: string;
  segments: DurableRecordingSegment[];
  finalAsset?: DurableFinalAsset;
  handoffCompletedAt?: string;
};

export type DurableFinalAsset = {
  relativePath: 'final/lecture.m4a';
  createdAt: string;
  durationMs: number;
  byteLength: number;
  container: 'm4a';
  sourceSegmentIds: string[];
};

export type DurableFinalizedOutput = {
  session: DurableRecordingSession;
  fileUri: string;
};

export type CreateDurableSessionInput = {
  lectureId: string;
};

export type TransitionDurableSessionInput = {
  recordingSessionId: string;
  state: DurableRecordingState;
  failureCode?: string;
  failureMessage?: string;
};

export type DurableSessionIdentifierInput = {
  recordingSessionId: string;
};

export const DURABLE_RECORDER_RUNTIME_STATES = [
  'idle',
  'preparing',
  'ready',
  'recording',
  'pausing',
  'paused',
  'resuming',
  'stopping',
  'interrupted',
  'failed',
] as const;

export type DurableRecorderRuntimeState = (typeof DURABLE_RECORDER_RUNTIME_STATES)[number];
export type DurableRecorderPermissionState = 'undetermined' | 'granted' | 'denied' | 'restricted';

export type PrepareDurableRecordingInput = DurableSessionIdentifierInput & {
  requestPermission?: boolean;
};

export type DurableRecordingStatus = {
  runtimeState: DurableRecorderRuntimeState;
  permission: DurableRecorderPermissionState;
  recordingSessionId?: string;
  activeSegmentId?: string;
  completedSegments: DurableRecordingSegment[];
  session?: DurableRecordingSession;
  interruptionState?: string;
  routeChangeState?: string;
};

export type DurableRecoveryIssue = {
  code: string;
  relativePath: string;
  segmentId?: string;
};

export type DurableRecordingRecoveryResult = {
  session: DurableRecordingSession;
  issues: DurableRecoveryIssue[];
};

export type DurableRecorderErrorCode =
  | 'ERR_DURABLE_RECORDER_UNAVAILABLE'
  | 'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT'
  | 'ERR_DURABLE_RECORDER_INVALID_IDENTIFIER'
  | 'ERR_DURABLE_RECORDER_INVALID_LECTURE_ID'
  | 'ERR_DURABLE_RECORDER_SESSION_NOT_FOUND'
  | 'ERR_DURABLE_RECORDER_INVALID_TRANSITION'
  | 'ERR_DURABLE_RECORDER_TERMINAL_STATE'
  | 'ERR_DURABLE_RECORDER_UNSUPPORTED_SCHEMA'
  | 'ERR_DURABLE_RECORDER_UNSUPPORTED_SEGMENT_SCHEMA'
  | 'ERR_DURABLE_RECORDER_INVALID_METADATA'
  | 'ERR_DURABLE_RECORDER_SESSION_NOT_TERMINAL'
  | 'ERR_DURABLE_RECORDER_BUSY'
  | 'ERR_DURABLE_RECORDER_INVALID_RECORDER_STATE'
  | 'ERR_DURABLE_RECORDER_PERMISSION_DENIED'
  | 'ERR_DURABLE_RECORDER_NO_AUDIO_INPUT'
  | 'ERR_DURABLE_RECORDER_START_FAILED'
  | 'ERR_DURABLE_RECORDER_SEGMENT_VALIDATION'
  | 'ERR_DURABLE_RECORDER_SEGMENT_COLLISION'
  | 'ERR_DURABLE_RECORDER_NO_FINALIZABLE_SEGMENTS'
  | 'ERR_DURABLE_RECORDER_FINAL_ASSET_EXPORT'
  | 'ERR_DURABLE_RECORDER_FINAL_ASSET_MISSING'
  | 'ERR_DURABLE_RECORDER_STORAGE';

export class DurableRecorderError extends Error {
  readonly code: DurableRecorderErrorCode;

  constructor(code: DurableRecorderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableRecorderError';
    this.code = code;
  }
}

type NativeDurableRecorderModule = {
  getCapabilities: () => Promise<unknown>;
  createSession: (input: CreateDurableSessionInput) => Promise<unknown>;
  getSession: (recordingSessionId: string) => Promise<unknown>;
  listRecoverableSessions: () => Promise<unknown>;
  transitionSession: (input: TransitionDurableSessionInput) => Promise<unknown>;
  finalizeSession: (input: DurableSessionIdentifierInput) => Promise<unknown>;
  abandonSession: (input: DurableSessionIdentifierInput) => Promise<unknown>;
  deleteSession: (recordingSessionId: string) => Promise<unknown>;
  getMicrophonePermissionStatus: () => Promise<unknown>;
  prepareRecording: (input: PrepareDurableRecordingInput) => Promise<unknown>;
  startRecording: (input: DurableSessionIdentifierInput) => Promise<unknown>;
  pauseRecording: (input: DurableSessionIdentifierInput) => Promise<unknown>;
  resumeRecording: (input: DurableSessionIdentifierInput) => Promise<unknown>;
  stopRecording: (input: DurableSessionIdentifierInput) => Promise<unknown>;
  getRecordingStatus: () => Promise<unknown>;
  recoverRecordingSession: (input: DurableSessionIdentifierInput) => Promise<unknown>;
  exportFinalizedAsset: (input: DurableSessionIdentifierInput) => Promise<unknown>;
  acknowledgeFinalAssetHandoff: (input: DurableSessionIdentifierInput) => Promise<unknown>;
};

const stateSet = new Set<string>(DURABLE_RECORDING_STATES);
const runtimeStateSet = new Set<string>(DURABLE_RECORDER_RUNTIME_STATES);
const permissionStateSet = new Set<string>(['undetermined', 'granted', 'denied', 'restricted']);
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function loadNativeModule(): NativeDurableRecorderModule | null {
  try {
    return requireOptionalNativeModule<NativeDurableRecorderModule>('ExpoDurableRecorder');
  } catch {
    return null;
  }
}

function unavailableCapabilities(): DurableRecorderCapabilities {
  return {
    moduleAvailable: false,
    contractVersion: DURABLE_RECORDER_CONTRACT_VERSION,
    platform: typeof Platform.OS === 'string' ? Platform.OS : 'unknown',
    implementation: 'unavailable',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validateSegment(value: unknown): DurableRecordingSegment | null {
  if (!isRecord(value)) return null;
  const {
    schemaVersion,
    segmentId,
    sequence,
    relativePath,
    createdAt,
    finalizedAt,
    durationMs,
    byteLength,
    container,
    codec,
    sampleRate,
    channelCount,
    integrityStatus,
    interruptionReason,
    routeAtStart,
    routeAtEnd,
    recoveredAfterRestart,
  } = value;
  if (
    schemaVersion !== 1 ||
    typeof segmentId !== 'string' ||
    !sessionIdPattern.test(segmentId) ||
    !Number.isInteger(sequence) ||
    (sequence as number) <= 0 ||
    !isTimestamp(createdAt) ||
    !isTimestamp(finalizedAt) ||
    !Number.isInteger(durationMs) ||
    (durationMs as number) <= 0 ||
    !Number.isInteger(byteLength) ||
    (byteLength as number) <= 0 ||
    container !== 'm4a' ||
    codec !== 'aac' ||
    typeof sampleRate !== 'number' ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isInteger(channelCount) ||
    (channelCount as number) <= 0 ||
    integrityStatus !== 'validated' ||
    typeof relativePath !== 'string' ||
    relativePath !== `segments/${String(sequence).padStart(6, '0')}-${segmentId}.m4a` ||
    (interruptionReason !== undefined && typeof interruptionReason !== 'string') ||
    (routeAtStart !== undefined && typeof routeAtStart !== 'string') ||
    (routeAtEnd !== undefined && typeof routeAtEnd !== 'string') ||
    (recoveredAfterRestart !== undefined && typeof recoveredAfterRestart !== 'boolean')
  ) {
    return null;
  }
  return {
    schemaVersion,
    segmentId,
    sequence: sequence as number,
    relativePath,
    createdAt,
    finalizedAt,
    durationMs: durationMs as number,
    byteLength: byteLength as number,
    container,
    codec,
    sampleRate,
    channelCount: channelCount as number,
    integrityStatus,
    ...(interruptionReason === undefined ? {} : { interruptionReason }),
    ...(routeAtStart === undefined ? {} : { routeAtStart }),
    ...(routeAtEnd === undefined ? {} : { routeAtEnd }),
    ...(recoveredAfterRestart === undefined ? {} : { recoveredAfterRestart }),
  };
}

function validateSession(value: unknown): DurableRecordingSession | null {
  if (!isRecord(value)) return null;
  const {
    schemaVersion,
    recordingSessionId,
    lectureId,
    state,
    createdAt,
    updatedAt,
    relativeSessionPath,
    recoverable,
    finalized,
    failureCode,
    failureMessage,
    segments,
    finalAsset,
    handoffCompletedAt,
  } = value;
  if (
    schemaVersion !== 1 ||
    typeof recordingSessionId !== 'string' ||
    !sessionIdPattern.test(recordingSessionId) ||
    typeof lectureId !== 'string' ||
    lectureId.length === 0 ||
    typeof state !== 'string' ||
    !stateSet.has(state) ||
    !isTimestamp(createdAt) ||
    !isTimestamp(updatedAt) ||
    relativeSessionPath !== `sessions/${recordingSessionId}` ||
    typeof recoverable !== 'boolean' ||
    typeof finalized !== 'boolean' ||
    (failureCode !== undefined && typeof failureCode !== 'string') ||
    (failureMessage !== undefined && typeof failureMessage !== 'string') ||
    !Array.isArray(segments)
  ) {
    return null;
  }
  const terminal = state === 'finalized' || state === 'failed' || state === 'abandoned';
  if (recoverable === terminal || finalized !== (state === 'finalized')) return null;
  const validatedSegments = segments.map(validateSegment);
  if (validatedSegments.some((segment) => segment === null)) return null;
  if (handoffCompletedAt !== undefined && !isTimestamp(handoffCompletedAt)) return null;
  const concreteSegments = validatedSegments as DurableRecordingSegment[];
  if (concreteSegments.some((segment, index) => segment.sequence !== index + 1)) return null;
  let validatedFinalAsset: DurableFinalAsset | undefined;
  if (finalAsset !== undefined) {
    if (!isRecord(finalAsset)) return null;
    const sourceSegmentIds = finalAsset.sourceSegmentIds;
    if (
      finalAsset.relativePath !== 'final/lecture.m4a' ||
      !isTimestamp(finalAsset.createdAt) ||
      !Number.isInteger(finalAsset.durationMs) ||
      (finalAsset.durationMs as number) <= 0 ||
      !Number.isInteger(finalAsset.byteLength) ||
      (finalAsset.byteLength as number) <= 0 ||
      finalAsset.container !== 'm4a' ||
      !Array.isArray(sourceSegmentIds) ||
      sourceSegmentIds.length !== concreteSegments.length ||
      sourceSegmentIds.some((id, index) => id !== concreteSegments[index]?.segmentId)
    ) return null;
    validatedFinalAsset = {
      relativePath: 'final/lecture.m4a',
      createdAt: finalAsset.createdAt,
      durationMs: finalAsset.durationMs as number,
      byteLength: finalAsset.byteLength as number,
      container: 'm4a',
      sourceSegmentIds: sourceSegmentIds as string[],
    };
  }
  return {
    schemaVersion,
    recordingSessionId,
    lectureId,
    state: state as DurableRecordingState,
    createdAt,
    updatedAt,
    relativeSessionPath,
    recoverable,
    finalized,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureMessage === undefined ? {} : { failureMessage }),
    segments: concreteSegments,
    ...(validatedFinalAsset ? { finalAsset: validatedFinalAsset } : {}),
    ...(handoffCompletedAt === undefined ? {} : { handoffCompletedAt }),
  };
}

function validateStatus(value: unknown): DurableRecordingStatus | null {
  if (!isRecord(value)) return null;
  const {
    runtimeState,
    permission,
    recordingSessionId,
    activeSegmentId,
    completedSegments,
    session,
    interruptionState,
    routeChangeState,
  } = value;
  if (
    typeof runtimeState !== 'string' ||
    !runtimeStateSet.has(runtimeState) ||
    typeof permission !== 'string' ||
    !permissionStateSet.has(permission) ||
    (recordingSessionId !== undefined &&
      (typeof recordingSessionId !== 'string' || !sessionIdPattern.test(recordingSessionId))) ||
    (activeSegmentId !== undefined &&
      (typeof activeSegmentId !== 'string' || !sessionIdPattern.test(activeSegmentId))) ||
    !Array.isArray(completedSegments) ||
    (interruptionState !== undefined && typeof interruptionState !== 'string') ||
    (routeChangeState !== undefined && typeof routeChangeState !== 'string')
  ) return null;
  const segments = completedSegments.map(validateSegment);
  if (segments.some((segment) => segment === null)) return null;
  const validatedSession = session === undefined ? undefined : validateSession(session);
  if (session !== undefined && !validatedSession) return null;
  return {
    runtimeState: runtimeState as DurableRecorderRuntimeState,
    permission: permission as DurableRecorderPermissionState,
    ...(recordingSessionId === undefined ? {} : { recordingSessionId }),
    ...(activeSegmentId === undefined ? {} : { activeSegmentId }),
    completedSegments: segments as DurableRecordingSegment[],
    ...(validatedSession ? { session: validatedSession } : {}),
    ...(interruptionState === undefined ? {} : { interruptionState }),
    ...(routeChangeState === undefined ? {} : { routeChangeState }),
  };
}

function requireStatus(value: unknown): DurableRecordingStatus {
  const status = validateStatus(value);
  if (!status) throw new DurableRecorderError(
    'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
    'The native durable recorder returned an invalid recording status.',
  );
  return status;
}

function requireSession(value: unknown): DurableRecordingSession {
  const session = validateSession(value);
  if (!session) {
    throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
      'The native durable recorder returned invalid session metadata.',
    );
  }
  return session;
}

function requireNativeModule(): NativeDurableRecorderModule {
  if (!nativeModule) {
    throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_UNAVAILABLE',
      'The native durable recorder module is unavailable on this platform.',
    );
  }
  return nativeModule;
}

function requireSessionId(recordingSessionId: unknown): string {
  if (typeof recordingSessionId !== 'string' || !sessionIdPattern.test(recordingSessionId)) {
    throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_IDENTIFIER',
      'The recording session identifier is invalid.',
    );
  }
  return recordingSessionId;
}

function normalizeError(error: unknown): DurableRecorderError {
  if (error instanceof DurableRecorderError) return error;
  if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
    return new DurableRecorderError(error.code as DurableRecorderErrorCode, error.message, { cause: error });
  }
  return new DurableRecorderError(
    'ERR_DURABLE_RECORDER_STORAGE',
    'The native durable recorder operation failed.',
    { cause: error },
  );
}

async function sessionOperation(operation: () => Promise<unknown>): Promise<DurableRecordingSession> {
  try {
    return requireSession(await operation());
  } catch (error) {
    throw normalizeError(error);
  }
}

const nativeModule = loadNativeModule();

export async function getCapabilities(): Promise<DurableRecorderCapabilities> {
  if (!nativeModule) return unavailableCapabilities();

  try {
    const result = await nativeModule.getCapabilities();
    if (!isRecord(result)) return unavailableCapabilities();
    if (
      result.moduleAvailable !== true ||
      result.contractVersion !== DURABLE_RECORDER_CONTRACT_VERSION ||
      result.platform !== 'ios' ||
      result.implementation !== 'native-foreground-audio'
    ) {
      return unavailableCapabilities();
    }
    return {
      moduleAvailable: true,
      contractVersion: DURABLE_RECORDER_CONTRACT_VERSION,
      platform: 'ios',
      implementation: 'native-foreground-audio',
    };
  } catch {
    return unavailableCapabilities();
  }
}

export async function createSession(input: CreateDurableSessionInput): Promise<DurableRecordingSession> {
  if (!input || typeof input.lectureId !== 'string' || input.lectureId.trim().length === 0) {
    throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_LECTURE_ID',
      'The lecture identifier must be a non-empty string.',
    );
  }
  return sessionOperation(() => requireNativeModule().createSession({ lectureId: input.lectureId.trim() }));
}

export async function getSession(recordingSessionId: string): Promise<DurableRecordingSession> {
  return sessionOperation(() => requireNativeModule().getSession(requireSessionId(recordingSessionId)));
}

export async function listRecoverableSessions(): Promise<DurableRecordingSession[]> {
  try {
    const result = await requireNativeModule().listRecoverableSessions();
    if (!Array.isArray(result)) throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
      'The native durable recorder returned an invalid recovery list.',
    );
    return result.map(requireSession);
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function transitionSession(
  input: TransitionDurableSessionInput,
): Promise<DurableRecordingSession> {
  if (!input || !stateSet.has(input.state)) {
    throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_METADATA',
      'The requested durable recording state is invalid.',
    );
  }
  return sessionOperation(() => requireNativeModule().transitionSession({
    ...input,
    recordingSessionId: requireSessionId(input.recordingSessionId),
  }));
}

export async function finalizeSession(
  input: DurableSessionIdentifierInput,
): Promise<DurableRecordingSession> {
  return sessionOperation(() => requireNativeModule().finalizeSession({
    recordingSessionId: requireSessionId(input?.recordingSessionId),
  }));
}

export async function abandonSession(
  input: DurableSessionIdentifierInput,
): Promise<DurableRecordingSession> {
  return sessionOperation(() => requireNativeModule().abandonSession({
    recordingSessionId: requireSessionId(input?.recordingSessionId),
  }));
}

export async function deleteSession(recordingSessionId: string): Promise<boolean> {
  try {
    const result = await requireNativeModule().deleteSession(requireSessionId(recordingSessionId));
    if (typeof result !== 'boolean') throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
      'The native durable recorder returned an invalid deletion result.',
    );
    return result;
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function getMicrophonePermissionStatus(): Promise<DurableRecorderPermissionState> {
  try {
    const result = await requireNativeModule().getMicrophonePermissionStatus();
    if (typeof result !== 'string' || !permissionStateSet.has(result)) throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
      'The native durable recorder returned an invalid microphone permission state.',
    );
    return result as DurableRecorderPermissionState;
  } catch (error) {
    throw normalizeError(error);
  }
}

async function statusOperation(operation: () => Promise<unknown>): Promise<DurableRecordingStatus> {
  try {
    return requireStatus(await operation());
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function prepareRecording(
  input: PrepareDurableRecordingInput,
): Promise<DurableRecordingStatus> {
  return statusOperation(() => requireNativeModule().prepareRecording({
    recordingSessionId: requireSessionId(input?.recordingSessionId),
    requestPermission: input?.requestPermission === true,
  }));
}

export async function startRecording(input: DurableSessionIdentifierInput): Promise<DurableRecordingStatus> {
  return statusOperation(() => requireNativeModule().startRecording({
    recordingSessionId: requireSessionId(input?.recordingSessionId),
  }));
}

export async function pauseRecording(input: DurableSessionIdentifierInput): Promise<DurableRecordingStatus> {
  return statusOperation(() => requireNativeModule().pauseRecording({
    recordingSessionId: requireSessionId(input?.recordingSessionId),
  }));
}

export async function resumeRecording(input: DurableSessionIdentifierInput): Promise<DurableRecordingStatus> {
  return statusOperation(() => requireNativeModule().resumeRecording({
    recordingSessionId: requireSessionId(input?.recordingSessionId),
  }));
}

export async function stopRecording(input: DurableSessionIdentifierInput): Promise<DurableRecordingStatus> {
  return statusOperation(() => requireNativeModule().stopRecording({
    recordingSessionId: requireSessionId(input?.recordingSessionId),
  }));
}

export async function getRecordingStatus(): Promise<DurableRecordingStatus> {
  return statusOperation(() => requireNativeModule().getRecordingStatus());
}

export async function recoverRecordingSession(
  input: DurableSessionIdentifierInput,
): Promise<DurableRecordingRecoveryResult> {
  try {
    const result = await requireNativeModule().recoverRecordingSession({
      recordingSessionId: requireSessionId(input?.recordingSessionId),
    });
    if (!isRecord(result) || !Array.isArray(result.issues)) throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
      'The native durable recorder returned an invalid recovery result.',
    );
    const session = requireSession(result.session);
    const issues = result.issues.map((issue): DurableRecoveryIssue | null => {
      if (!isRecord(issue) || typeof issue.code !== 'string' ||
          typeof issue.relativePath !== 'string' || !issue.relativePath.startsWith('segments/') ||
          issue.relativePath.includes('..') || issue.relativePath.includes('\\') ||
          (issue.segmentId !== undefined &&
            (typeof issue.segmentId !== 'string' || !sessionIdPattern.test(issue.segmentId)))) return null;
      return {
        code: issue.code,
        relativePath: issue.relativePath,
        ...(issue.segmentId === undefined ? {} : { segmentId: issue.segmentId }),
      };
    });
    if (issues.some((issue) => issue === null)) throw new DurableRecorderError(
      'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
      'The native durable recorder returned an invalid recovery issue.',
    );
    return { session, issues: issues as DurableRecoveryIssue[] };
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function exportFinalizedAsset(
  input: DurableSessionIdentifierInput,
): Promise<DurableFinalizedOutput> {
  try {
    const result = await requireNativeModule().exportFinalizedAsset({
      recordingSessionId: requireSessionId(input?.recordingSessionId),
    });
    if (!isRecord(result) || typeof result.fileUri !== 'string' || !result.fileUri.startsWith('file://')) {
      throw new DurableRecorderError(
        'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
        'The native durable recorder returned an invalid final asset.',
      );
    }
    const session = requireSession(result.session);
    if (!session.finalAsset || session.state !== 'finalized') {
      throw new DurableRecorderError(
        'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT',
        'The native durable recorder returned incomplete final asset metadata.',
      );
    }
    return { session, fileUri: result.fileUri };
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function acknowledgeFinalAssetHandoff(
  input: DurableSessionIdentifierInput,
): Promise<DurableRecordingSession> {
  try {
    return requireSession(await requireNativeModule().acknowledgeFinalAssetHandoff({
      recordingSessionId: requireSessionId(input?.recordingSessionId),
    }));
  } catch (error) {
    throw normalizeError(error);
  }
}
