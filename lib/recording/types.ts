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
  /**
   * Legacy recorder's current in-flight file. It is available immediately
   * after native preparation, before a graceful stop produces recordingUri.
   * Native durable sessions keep their own durable recovery state instead.
   */
  liveFileUri: string | null;
  error: string | null;
  errorDetail: string | null;
  requestPermission: () => Promise<boolean>;
  startRecording: () => Promise<boolean>;
  /** True only when the recorder completed the requested state transition. */
  pauseRecording: () => Promise<boolean>;
  resumeRecording: () => Promise<boolean>;
  stopRecording: () => Promise<string | null>;
  /**
   * Duration of the durable final audio produced by the last successful `stopRecording`, in ms. Native durable engine
   * only (null otherwise): this — never the JS wall-clock timer — is the lecture's authoritative final duration.
   */
  getFinalAudioDurationMillis?: () => number | null;
  leaveRecording: () => Promise<string | null>;
  recoverRecording: () => Promise<boolean>;
  finishRecoverableRecording: () => Promise<string | null>;
  acknowledgeFinalizedOutput: () => Promise<boolean>;
  discardRecoverableRecording: () => Promise<void>;
  dismissRecovery: () => void;
};
