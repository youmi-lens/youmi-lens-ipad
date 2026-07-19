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
  segmentId: string;
  createdAt: string;
  relativePath: string;
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

export type DurableRecorderErrorCode =
  | 'ERR_DURABLE_RECORDER_UNAVAILABLE'
  | 'ERR_DURABLE_RECORDER_INVALID_NATIVE_RESULT'
  | 'ERR_DURABLE_RECORDER_INVALID_IDENTIFIER'
  | 'ERR_DURABLE_RECORDER_INVALID_LECTURE_ID'
  | 'ERR_DURABLE_RECORDER_SESSION_NOT_FOUND'
  | 'ERR_DURABLE_RECORDER_INVALID_TRANSITION'
  | 'ERR_DURABLE_RECORDER_TERMINAL_STATE'
  | 'ERR_DURABLE_RECORDER_UNSUPPORTED_SCHEMA'
  | 'ERR_DURABLE_RECORDER_INVALID_METADATA'
  | 'ERR_DURABLE_RECORDER_SESSION_NOT_TERMINAL'
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
};

const stateSet = new Set<string>(DURABLE_RECORDING_STATES);
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
  const { segmentId, createdAt, relativePath } = value;
  if (
    typeof segmentId !== 'string' ||
    !sessionIdPattern.test(segmentId) ||
    !isTimestamp(createdAt) ||
    typeof relativePath !== 'string' ||
    !relativePath.startsWith('segments/') ||
    relativePath.includes('..') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/')
  ) {
    return null;
  }
  return { segmentId, createdAt, relativePath };
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
    segments: validatedSegments as DurableRecordingSegment[],
  };
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
      result.implementation !== 'native-placeholder'
    ) {
      return unavailableCapabilities();
    }
    return {
      moduleAvailable: true,
      contractVersion: DURABLE_RECORDER_CONTRACT_VERSION,
      platform: 'ios',
      implementation: 'native-placeholder',
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
