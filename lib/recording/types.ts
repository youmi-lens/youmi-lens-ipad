import type { DurableRecordingSession } from '@/modules/expo-durable-recorder';

import type { RecordingEngine } from './featureGate';

export type RecorderPermission = 'undetermined' | 'granted' | 'denied';

export type LectureRecorder = {
  engine: RecordingEngine;
  permissionChecked: boolean;
  permissionStatus: RecorderPermission;
  recoveryChecked: boolean;
  recoverableSession: DurableRecordingSession | null;
  isRecording: boolean;
  isPaused: boolean;
  durationMillis: number;
  recordingUri: string | null;
  error: string | null;
  errorDetail: string | null;
  requestPermission: () => Promise<boolean>;
  startRecording: () => Promise<boolean>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  leaveRecording: () => Promise<string | null>;
  recoverRecording: () => Promise<boolean>;
  finishRecoverableRecording: () => Promise<string | null>;
  acknowledgeFinalizedOutput: () => Promise<boolean>;
  discardRecoverableRecording: () => Promise<void>;
  dismissRecovery: () => void;
};
