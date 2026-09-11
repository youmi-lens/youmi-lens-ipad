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
  /**
   * Non-null only while paused for a reason the owner didn't choose — a
   * checkpoint rollover failing to open its next segment, an
   * AVAudioSession interruption, or a route change forcing a pause. A
   * short, stable reason code (e.g. `checkpoint_begin_segment_failed`),
   * never raw native error text — safe to show or log in any build. Null
   * for an ordinary user-initiated pause, and always null for the legacy
   * engine (which has no forced-pause concept of its own).
   */
  degradedReason: string | null;
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
